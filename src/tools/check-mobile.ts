import { z } from "zod";
import { withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkMobileSchema = {
  url: z.string().url().describe("The URL to check for mobile-friendliness"),
};

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export async function checkMobile({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();

  return withPuppeteerTimeout(async () => {
    const puppeteer = await import("puppeteer");

    let browser;
    try {
      browser = await puppeteer.default.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });

      const page = await browser.newPage();
      await page.setViewport({ width: 375, height: 812 });
      await page.setUserAgent(MOBILE_UA);

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      const analysis = await page.evaluate(() => {
        const viewportMeta = document.querySelector(
          'meta[name="viewport"]'
        ) as HTMLMetaElement | null;
        const viewportContent = viewportMeta?.content ?? null;

        const hasHorizontalScroll =
          document.documentElement.scrollWidth > window.innerWidth;

        let smallFontsCount = 0;
        const textElements = document.querySelectorAll(
          "p, span, li, td, th, label, a, div, h1, h2, h3, h4, h5, h6"
        );
        for (const el of textElements) {
          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize);
          if (fontSize > 0 && fontSize < 12) {
            smallFontsCount++;
          }
        }

        let smallTapTargetsCount = 0;
        const tapTargets = document.querySelectorAll("a, button, input, select, textarea");
        for (const el of tapTargets) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (rect.width < 48 || rect.height < 48) {
              smallTapTargetsCount++;
            }
          }
        }

        return {
          viewportContent,
          hasViewportMeta: viewportMeta !== null,
          hasHorizontalScroll,
          smallFontsCount,
          smallTapTargetsCount,
        };
      });

      // Take screenshot
      const imageBuffer = await page.screenshot({
        fullPage: false,
        type: "jpeg",
        quality: 70,
      });
      const screenshotBase64 = Buffer.from(imageBuffer).toString("base64");

      // Build issues
      const issues = [];

      if (!analysis.hasViewportMeta) {
        issues.push(createIssue("error", "viewport-meta", "Missing <meta name=\"viewport\"> tag. Page will not scale properly on mobile devices."));
      } else {
        issues.push(createIssue("info", "viewport-meta", `Viewport meta found: ${analysis.viewportContent}`, analysis.viewportContent ?? undefined));
      }

      if (analysis.hasHorizontalScroll) {
        issues.push(createIssue("error", "horizontal-scroll", "Content wider than viewport — horizontal scrollbar detected on mobile."));
      }

      if (analysis.smallFontsCount > 0) {
        issues.push(createIssue("warning", "small-fonts", `${analysis.smallFontsCount} element(s) have font-size smaller than 12px, which may be hard to read on mobile.`, `${analysis.smallFontsCount} elements`));
      }

      if (analysis.smallTapTargetsCount > 0) {
        issues.push(createIssue("warning", "small-tap-targets", `${analysis.smallTapTargetsCount} tap target(s) (links/buttons) are smaller than 48x48px, making them hard to tap on mobile.`, `${analysis.smallTapTargetsCount} targets`));
      }

      // Score
      let score = 100;
      if (!analysis.hasViewportMeta) score -= 30;
      if (analysis.hasHorizontalScroll) score -= 10;
      if (analysis.smallFontsCount > 0) score -= 5;
      score -= Math.floor(analysis.smallTapTargetsCount / 10) * 5;
      score = Math.max(0, score);

      return {
        url,
        finalUrl: page.url(),
        status: 200,
        score,
        summary: `Audit mobile de ${url}: score ${score}/100, ${analysis.smallTapTargetsCount} tap targets trop petits`,
        issues,
        recommendations: generateRecommendations(issues),
        meta: createMeta(startTime, "puppeteer", false, false),
        data: {
          viewport: { width: 375, height: 812 },
          hasViewportMeta: analysis.hasViewportMeta,
          viewportContent: analysis.viewportContent,
          hasHorizontalScroll: analysis.hasHorizontalScroll,
          smallFontsCount: analysis.smallFontsCount,
          smallTapTargetsCount: analysis.smallTapTargetsCount,
          screenshotBase64,
          screenshotMimeType: "image/jpeg",
        },
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }, 45000);
}
