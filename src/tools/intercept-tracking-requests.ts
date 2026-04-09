import { z } from "zod";
import { withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  calculateScore,
  generateRecommendations,
} from "../utils/response.js";

export const interceptTrackingRequestsSchema = {
  url: z.string().url().describe("The URL to monitor for tracking requests"),
  wait_ms: z
    .number()
    .min(0)
    .max(8000)
    .default(3000)
    .describe("Milliseconds to wait after page load to capture tracking hits (default: 3000, max: 8000)"),
};

interface GA4Hit {
  measurement_id: string;
  event_name: string;
  protocol_version: string;
  raw_params: Record<string, string>;
}

export async function interceptTrackingRequests({
  url,
  wait_ms = 3000,
}: {
  url: string;
  wait_ms?: number;
}): Promise<StandardResponse> {
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

      const ga4Hits: GA4Hit[] = [];
      let gtmLoaded = false;
      let gtagLoaded = false;
      let uaHitsDetected = false;

      // Enable request interception
      await page.setRequestInterception(true);

      page.on("request", (request) => {
        const reqUrl = request.url();

        // GTM container loading
        if (reqUrl.includes("googletagmanager.com/gtm.js")) {
          gtmLoaded = true;
        }

        // gtag.js loading
        if (reqUrl.includes("googletagmanager.com/gtag/js")) {
          gtagLoaded = true;
        }

        // GA4 hits: /g/collect
        if (
          reqUrl.includes("google-analytics.com/g/collect") ||
          reqUrl.includes("analytics.google.com/g/collect")
        ) {
          try {
            const parsed = new URL(reqUrl);
            const params: Record<string, string> = {};
            parsed.searchParams.forEach((value, key) => {
              params[key] = value;
            });

            ga4Hits.push({
              measurement_id: params["tid"] || "unknown",
              event_name: params["en"] || "unknown",
              protocol_version: params["v"] || "unknown",
              raw_params: params,
            });
          } catch {
            // Ignore malformed URLs
          }
        }

        // Old Universal Analytics hits (obsolete)
        if (reqUrl.includes("stats.g.doubleclick.net")) {
          uaHitsDetected = true;
        }

        // Let the request continue
        request.continue();
      });

      // Navigate to the page
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // Wait additional time to capture deferred tracking hits
      if (wait_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait_ms));
      }

      // Analyze results
      const measurementIds = [
        ...new Set(ga4Hits.map((h) => h.measurement_id)),
      ];

      // Detect duplicate events (same event_name fired multiple times)
      const eventCounts: Record<string, number> = {};
      for (const hit of ga4Hits) {
        eventCounts[hit.event_name] =
          (eventCounts[hit.event_name] || 0) + 1;
      }
      const duplicateEvents = Object.entries(eventCounts)
        .filter(([, count]) => count > 1)
        .map(([name]) => name);

      // Build issues
      const issues = [];

      if (ga4Hits.length === 0) {
        issues.push(
          createIssue(
            "error",
            "no-ga4-hits",
            "No GA4 hits detected. Tracking is likely broken — no data is being sent to Google Analytics."
          )
        );
      }

      if (uaHitsDetected) {
        issues.push(
          createIssue(
            "error",
            "ua-obsolete",
            "Universal Analytics hits detected (stats.g.doubleclick.net). UA has been sunset since July 2024 — these hits are not processed by Google."
          )
        );
      }

      if (duplicateEvents.length > 0) {
        issues.push(
          createIssue(
            "warning",
            "duplicate-events",
            `Duplicate event(s) detected: ${duplicateEvents.join(", ")}. This may cause double-counting in reports.`,
            duplicateEvents.join(", ")
          )
        );
      }

      if (measurementIds.length > 1) {
        issues.push(
          createIssue(
            "warning",
            "multiple-measurement-ids",
            `Multiple GA4 measurement IDs detected: ${measurementIds.join(", ")}. Verify this is intentional (e.g., multi-property setup).`,
            measurementIds.join(", ")
          )
        );
      }

      if (
        ga4Hits.length > 0 &&
        duplicateEvents.length === 0 &&
        !uaHitsDetected
      ) {
        const eventNames = [
          ...new Set(ga4Hits.map((h) => h.event_name)),
        ];
        issues.push(
          createIssue(
            "info",
            "tracking-ok",
            `${ga4Hits.length} GA4 hit(s) captured: ${eventNames.join(", ")}`,
            measurementIds.join(", ")
          )
        );
      }

      const score = calculateScore(issues);

      return {
        url,
        finalUrl: page.url(),
        status: 200,
        score,
        summary: `Tracking intercept de ${url}: ${ga4Hits.length} GA4 hit(s), ${measurementIds.length} measurement ID(s), score ${score}/100`,
        issues,
        recommendations: generateRecommendations(issues),
        meta: createMeta(startTime, "puppeteer", false, false),
        data: {
          ga4_hits: ga4Hits,
          gtm_loaded: gtmLoaded,
          gtag_loaded: gtagLoaded,
          ua_hits_detected: uaHitsDetected,
          duplicate_events: duplicateEvents,
          total_hits: ga4Hits.length,
          measurement_ids: measurementIds,
        },
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }, 45000);
}
