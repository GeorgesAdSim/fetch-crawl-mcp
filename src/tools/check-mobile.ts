import { z } from "zod";

export const checkMobileSchema = {
  url: z.string().url().describe("The URL to check for mobile-friendliness"),
};

type Severity = "error" | "warning" | "info";

interface Issue {
  severity: Severity;
  message: string;
}

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export async function checkMobile({ url }: { url: string }) {
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
      // Viewport meta
      const viewportMeta = document.querySelector(
        'meta[name="viewport"]'
      ) as HTMLMetaElement | null;
      const viewportContent = viewportMeta?.content ?? null;

      // Horizontal scroll
      const hasHorizontalScroll =
        document.documentElement.scrollWidth > window.innerWidth;

      // Small fonts (< 12px)
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

      // Small tap targets (< 48px)
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
    const issues: Issue[] = [];

    if (!analysis.hasViewportMeta) {
      issues.push({
        severity: "error",
        message:
          "Missing <meta name=\"viewport\"> tag. Page will not scale properly on mobile devices.",
      });
    } else {
      issues.push({
        severity: "info",
        message: `Viewport meta found: ${analysis.viewportContent}`,
      });
    }

    if (analysis.hasHorizontalScroll) {
      issues.push({
        severity: "error",
        message:
          "Content wider than viewport — horizontal scrollbar detected on mobile.",
      });
    }

    if (analysis.smallFontsCount > 0) {
      issues.push({
        severity: "warning",
        message: `${analysis.smallFontsCount} element(s) have font-size smaller than 12px, which may be hard to read on mobile.`,
      });
    }

    if (analysis.smallTapTargetsCount > 0) {
      issues.push({
        severity: "warning",
        message: `${analysis.smallTapTargetsCount} tap target(s) (links/buttons) are smaller than 48x48px, making them hard to tap on mobile.`,
      });
    }

    return {
      url,
      viewport: { width: 375, height: 812 },
      hasViewportMeta: analysis.hasViewportMeta,
      viewportContent: analysis.viewportContent,
      hasHorizontalScroll: analysis.hasHorizontalScroll,
      smallFontsCount: analysis.smallFontsCount,
      smallTapTargetsCount: analysis.smallTapTargetsCount,
      issues,
      screenshotBase64,
      screenshotMimeType: "image/jpeg",
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
