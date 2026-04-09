import { z } from "zod";
import { withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  calculateScore,
  generateRecommendations,
} from "../utils/response.js";

export const checkDatalayerSchema = {
  url: z.string().url().describe("The URL to check for dataLayer"),
  wait_ms: z
    .number()
    .min(0)
    .max(5000)
    .default(2000)
    .describe("Milliseconds to wait after page load before reading dataLayer (default: 2000, max: 5000)"),
};

export async function checkDatalayer({
  url,
  wait_ms = 2000,
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

      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 25000,
      });

      // Wait additional time for dataLayer to be populated
      if (wait_ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait_ms));
      }

      const analysis = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;

        const datalayerExists = Array.isArray(w.dataLayer);
        const datalayerLength = datalayerExists
          ? (w.dataLayer as unknown[]).length
          : 0;

        // Get dataLayer events (max 20)
        let datalayerEvents: object[] = [];
        if (datalayerExists) {
          const dl = w.dataLayer as object[];
          datalayerEvents = dl.slice(0, 20).map((item) => {
            try {
              // Serialize and parse to remove non-serializable values
              return JSON.parse(JSON.stringify(item));
            } catch {
              return { _error: "non-serializable entry" };
            }
          });
        }

        // Check if google_tag_manager object exists (GTM runtime loaded)
        const gtmLoaded = typeof w.google_tag_manager === "object" && w.google_tag_manager !== null;

        // Check if gtag function exists
        const gtagFunction = typeof w.gtag === "function";

        // Detect suspicious patterns
        const suspiciousPatterns: string[] = [];

        // Check all scripts for dataLayer redefinition after GTM
        const scripts = document.querySelectorAll("script");
        let gtmFound = false;
        for (const script of scripts) {
          const content = script.innerHTML || "";
          const src = script.getAttribute("src") || "";

          if (
            src.includes("googletagmanager.com/gtm.js") ||
            content.includes("googletagmanager.com/gtm.js")
          ) {
            gtmFound = true;
          }

          // After GTM is found, check if dataLayer is redefined (overwritten)
          if (gtmFound && content.match(/dataLayer\s*=\s*\[/)) {
            suspiciousPatterns.push(
              "dataLayer redefined (= []) after GTM initialization — this resets all prior events"
            );
          }
        }

        // Check if dataLayer has no gtm.js event (GTM loaded but not working)
        if (datalayerExists && datalayerLength > 0) {
          const hasGtmStart = (w.dataLayer as Array<Record<string, unknown>>).some(
            (item) => item.event === "gtm.js"
          );
          if (!hasGtmStart && gtmFound) {
            suspiciousPatterns.push(
              "GTM script found in HTML but no gtm.js event in dataLayer — GTM may not be loading correctly"
            );
          }
        }

        return {
          datalayerExists,
          datalayerLength,
          datalayerEvents,
          gtmLoaded,
          gtagFunction,
          suspiciousPatterns,
        };
      });

      // Build issues
      const issues = [];

      if (!analysis.datalayerExists) {
        issues.push(
          createIssue(
            "error",
            "datalayer-missing",
            "window.dataLayer does not exist. No data is being pushed to GTM/GA4."
          )
        );
      } else if (analysis.datalayerLength === 0) {
        issues.push(
          createIssue(
            "warning",
            "datalayer-empty",
            "window.dataLayer exists but is empty (length = 0). No events have been pushed yet."
          )
        );
      } else {
        issues.push(
          createIssue(
            "info",
            "datalayer-ok",
            `window.dataLayer contains ${analysis.datalayerLength} event(s).`,
            `${analysis.datalayerLength} events`
          )
        );
      }

      if (!analysis.gtmLoaded) {
        issues.push(
          createIssue(
            "warning",
            "gtm-runtime",
            "window.google_tag_manager is absent — GTM container may not have loaded properly."
          )
        );
      }

      if (analysis.gtagFunction) {
        issues.push(
          createIssue(
            "info",
            "gtag-function",
            "window.gtag function detected — gtag.js is active."
          )
        );
      }

      for (const pattern of analysis.suspiciousPatterns) {
        issues.push(
          createIssue("warning", "suspicious-pattern", pattern)
        );
      }

      const score = calculateScore(issues);

      return {
        url,
        finalUrl: page.url(),
        status: 200,
        score,
        summary: `DataLayer audit de ${url}: ${analysis.datalayerExists ? `${analysis.datalayerLength} events` : "dataLayer absent"}, score ${score}/100`,
        issues,
        recommendations: generateRecommendations(issues),
        meta: createMeta(startTime, "puppeteer", false, false),
        data: {
          datalayer_exists: analysis.datalayerExists,
          datalayer_length: analysis.datalayerLength,
          datalayer_events: analysis.datalayerEvents,
          gtm_loaded: analysis.gtmLoaded,
          gtag_function: analysis.gtagFunction,
          suspicious_patterns: analysis.suspiciousPatterns,
        },
      };
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }, 30000);
}
