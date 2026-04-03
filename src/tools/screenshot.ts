import { z } from "zod";
import type { Page } from "puppeteer";
import { withPuppeteerTimeout } from "../utils/fetcher.js";

export const screenshotSchema = {
  url: z.string().url().describe("The URL to capture"),
  width: z
    .number()
    .int()
    .min(320)
    .max(3840)
    .default(1280)
    .describe("Viewport width in pixels"),
  height: z
    .number()
    .int()
    .min(240)
    .max(2160)
    .default(800)
    .describe("Viewport height in pixels"),
  fullPage: z
    .boolean()
    .default(false)
    .describe("Capture the full scrollable page"),
  format: z
    .enum(["png", "jpeg"])
    .default("png")
    .describe("Image format: png or jpeg"),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(80)
    .describe("Image quality (1-100), only used for jpeg format"),
  waitForSelector: z
    .string()
    .optional()
    .describe(
      "CSS selector to wait for before capturing. Puppeteer will wait until this element is visible."
    ),
  dismissCookies: z
    .boolean()
    .default(false)
    .describe(
      "If true, attempt to dismiss common cookie consent banners before capturing"
    ),
};

const COOKIE_BUTTON_TEXTS = [
  "accept",
  "accepter",
  "j'accepte",
  "rejeter",
  "reject",
  "tout accepter",
  "agree",
  "ok",
];

const COOKIE_ATTR_KEYWORDS = ["cookie", "consent", "gdpr"];

async function dismissCookieBanners(page: Page): Promise<void> {
  try {
    await page.evaluate(
      (buttonTexts: string[], attrKeywords: string[]) => {
        const buttons = Array.from(
          document.querySelectorAll(
            'button, a[role="button"], [type="button"], [type="submit"]'
          )
        );

        for (const btn of buttons) {
          const el = btn as HTMLElement;
          const text = (el.textContent || "").trim().toLowerCase();
          const id = (el.id || "").toLowerCase();
          const cls = (el.className || "").toString().toLowerCase();

          const matchesText = buttonTexts.some((t) => text.includes(t));
          const matchesAttr = attrKeywords.some(
            (k) => id.includes(k) || cls.includes(k)
          );

          if (matchesText || matchesAttr) {
            el.click();
            return;
          }
        }
      },
      COOKIE_BUTTON_TEXTS,
      COOKIE_ATTR_KEYWORDS
    );
  } catch {
    // Ignore errors — cookie banner dismissal is best-effort
  }
}

const MAX_IMAGE_SIZE = 900 * 1024; // 900KB

export async function screenshot({
  url,
  width,
  height,
  fullPage,
  format,
  quality,
  waitForSelector,
  dismissCookies,
}: {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
  format: "png" | "jpeg";
  quality: number;
  waitForSelector?: string;
  dismissCookies: boolean;
}) {
  const startTime = performance.now();

  try {
    return await withPuppeteerTimeout(async () => {
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
        await page.setViewport({ width, height });
        await page.goto(url, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });

        if (waitForSelector) {
          await page.waitForSelector(waitForSelector, {
            visible: true,
            timeout: 10000,
          });
        }

        if (dismissCookies) {
          await dismissCookieBanners(page);
          await new Promise((r) => setTimeout(r, 500));
        }

        let imageBuffer: Uint8Array;
        let finalFormat = format;
        let finalMimeType: string;

        if (format === "jpeg") {
          imageBuffer = await page.screenshot({ fullPage, type: "jpeg", quality });
        } else {
          imageBuffer = await page.screenshot({ fullPage, type: "png" });
        }

        // Auto-recompress if fullPage PNG exceeds 900KB
        if (fullPage && imageBuffer.length > MAX_IMAGE_SIZE && format === "png") {
          imageBuffer = await page.screenshot({ fullPage, type: "jpeg", quality: 60 });
          finalFormat = "jpeg";
        }

        finalMimeType = finalFormat === "jpeg" ? "image/jpeg" : "image/png";
        const base64 = Buffer.from(imageBuffer).toString("base64");

        return {
          url,
          width,
          height,
          fullPage,
          format: finalFormat,
          imageBase64: base64,
          mimeType: finalMimeType,
          meta: {
            durationMs: Math.round(performance.now() - startTime),
            timestamp: new Date().toISOString(),
          },
        };
      } finally {
        if (browser) {
          await browser.close();
        }
      }
    }, 45000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      width,
      height,
      fullPage,
      format,
      imageBase64: "",
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      error: `Screenshot failed: ${message}`,
      meta: {
        durationMs: Math.round(performance.now() - startTime),
        timestamp: new Date().toISOString(),
      },
    };
  }
}
