import { z } from "zod";


export const checkPerformanceSchema = {
  url: z.string().url().describe("The URL to audit"),
  device: z
    .enum(["mobile", "desktop"])
    .default("mobile")
    .describe("Device profile: mobile (375x812 + throttled) or desktop (1280x800)"),
};

type Severity = "error" | "warning" | "info";

interface Issue {
  metric: string;
  value: number;
  threshold: string;
  severity: Severity;
  message: string;
}

interface ResourceCount {
  scripts: number;
  styles: number;
  images: number;
  fonts: number;
  other: number;
}

function scoreMetric(
  value: number,
  good: number,
  needs: number
): { score: number; severity: Severity } {
  if (value <= good) return { score: 100, severity: "info" };
  if (value <= needs) return { score: 50, severity: "warning" };
  return { score: 0, severity: "error" };
}

export async function checkPerformance({
  url,
  device,
}: {
  url: string;
  device: "mobile" | "desktop";
}) {
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

    const isMobile = device === "mobile";
    const width = isMobile ? 375 : 1280;
    const height = isMobile ? 812 : 800;
    await page.setViewport({ width, height });

    // Network throttling for mobile
    if (isMobile) {
      const cdp = await page.createCDPSession();
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
        uploadThroughput: (750 * 1024) / 8, // 750 Kbps
      });
    }

    // Track network requests
    let totalRequests = 0;
    let totalBytes = 0;
    const resourceCounts: ResourceCount = {
      scripts: 0,
      styles: 0,
      images: 0,
      fonts: 0,
      other: 0,
    };

    page.on("response", async (response) => {
      totalRequests++;
      const headers = response.headers();
      const contentLength = parseInt(headers["content-length"] || "0", 10);
      totalBytes += contentLength;

      const resourceType = response.request().resourceType();
      switch (resourceType) {
        case "script":
          resourceCounts.scripts++;
          break;
        case "stylesheet":
          resourceCounts.styles++;
          break;
        case "image":
          resourceCounts.images++;
          break;
        case "font":
          resourceCounts.fonts++;
          break;
        default:
          resourceCounts.other++;
          break;
      }
    });

    // Set up LCP observer before navigation
    await page.evaluateOnNewDocument(() => {
      (window as any).__LCP__ = 0;
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          (window as any).__LCP__ = entries[entries.length - 1].startTime;
        }
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Wait a bit for LCP observer to fire
    await new Promise((r) => setTimeout(r, 1000));

    // Collect timing metrics
    const metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType(
        "navigation"
      )[0] as PerformanceNavigationTiming;

      // FCP from paint entries
      const paintEntries = performance.getEntriesByType("paint");
      const fcpEntry = paintEntries.find(
        (e) => e.name === "first-contentful-paint"
      );

      return {
        ttfb: nav.responseStart - nav.requestStart,
        fcp: fcpEntry ? fcpEntry.startTime : 0,
        lcp: (window as any).__LCP__ || 0,
        domContentLoaded:
          nav.domContentLoadedEventEnd - nav.startTime,
        fullyLoaded: nav.loadEventEnd - nav.startTime,
      };
    });

    // Score calculation
    const lcpResult = scoreMetric(metrics.lcp, 2500, 4000);
    const fcpResult = scoreMetric(metrics.fcp, 1800, 3000);
    const ttfbResult = scoreMetric(metrics.ttfb, 800, 1800);

    const score = Math.round(
      lcpResult.score * 0.4 + fcpResult.score * 0.35 + ttfbResult.score * 0.25
    );

    // Build issues
    const issues: Issue[] = [];

    issues.push({
      metric: "LCP",
      value: Math.round(metrics.lcp),
      threshold: "good < 2500ms, needs improvement < 4000ms",
      severity: lcpResult.severity,
      message:
        lcpResult.severity === "info"
          ? `LCP is good at ${Math.round(metrics.lcp)}ms`
          : lcpResult.severity === "warning"
            ? `LCP needs improvement: ${Math.round(metrics.lcp)}ms (target < 2500ms)`
            : `LCP is poor: ${Math.round(metrics.lcp)}ms (target < 2500ms)`,
    });

    issues.push({
      metric: "FCP",
      value: Math.round(metrics.fcp),
      threshold: "good < 1800ms, needs improvement < 3000ms",
      severity: fcpResult.severity,
      message:
        fcpResult.severity === "info"
          ? `FCP is good at ${Math.round(metrics.fcp)}ms`
          : fcpResult.severity === "warning"
            ? `FCP needs improvement: ${Math.round(metrics.fcp)}ms (target < 1800ms)`
            : `FCP is poor: ${Math.round(metrics.fcp)}ms (target < 1800ms)`,
    });

    issues.push({
      metric: "TTFB",
      value: Math.round(metrics.ttfb),
      threshold: "good < 800ms, needs improvement < 1800ms",
      severity: ttfbResult.severity,
      message:
        ttfbResult.severity === "info"
          ? `TTFB is good at ${Math.round(metrics.ttfb)}ms`
          : ttfbResult.severity === "warning"
            ? `TTFB needs improvement: ${Math.round(metrics.ttfb)}ms (target < 800ms)`
            : `TTFB is poor: ${Math.round(metrics.ttfb)}ms (target < 800ms)`,
    });

    return {
      url,
      device,
      viewport: { width, height },
      score,
      metrics: {
        ttfb: Math.round(metrics.ttfb),
        fcp: Math.round(metrics.fcp),
        lcp: Math.round(metrics.lcp),
        domContentLoaded: Math.round(metrics.domContentLoaded),
        fullyLoaded: Math.round(metrics.fullyLoaded),
      },
      network: {
        totalRequests,
        totalBytesTransferred: totalBytes,
        resourceCounts,
      },
      issues,
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
