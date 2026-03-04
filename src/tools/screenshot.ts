import { z } from "zod";

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
};

export async function screenshot({
  url,
  width,
  height,
  fullPage,
}: {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
}) {
  // Dynamic import to avoid loading puppeteer when not needed
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

    const imageBuffer = await page.screenshot({
      fullPage,
      type: "png",
    });

    const base64 = Buffer.from(imageBuffer).toString("base64");

    return {
      url,
      width,
      height,
      fullPage,
      imageBase64: base64,
      mimeType: "image/png",
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
