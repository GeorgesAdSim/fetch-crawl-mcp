import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  calculateScore,
  generateRecommendations,
} from "../utils/response.js";
import * as cheerio from "cheerio";

export const checkGtmSnippetSchema = {
  url: z.string().url().describe("The URL to check for GTM/gtag snippets"),
};

export async function checkGtmSnippet({
  url,
}: {
  url: string;
}): Promise<StandardResponse> {
  const startTime = performance.now();
  const result = await fetchUrl(url);
  const $ = cheerio.load(result.body);

  const gtmIds: string[] = [];
  const ga4Ids: string[] = [];
  let gtmInHead = false;
  let gtmInBodyNoscript = false;
  let tagManagerUrl: string | null = null;

  // Search for GTM snippet: script containing "googletagmanager.com/gtm.js?id="
  $("script").each((_i, el) => {
    const src = $(el).attr("src") || "";
    const content = $(el).html() || "";
    const combined = src + " " + content;

    // GTM container script
    const gtmMatches = combined.match(/GTM-[A-Z0-9]+/g);
    if (gtmMatches) {
      for (const id of gtmMatches) {
        if (!gtmIds.includes(id)) {
          gtmIds.push(id);
        }
      }
    }

    // Detect GTM script URL
    if (
      src.includes("googletagmanager.com/gtm.js") ||
      content.includes("googletagmanager.com/gtm.js")
    ) {
      if (!tagManagerUrl && src.includes("googletagmanager.com/gtm.js")) {
        tagManagerUrl = src;
      } else if (!tagManagerUrl) {
        const urlMatch = content.match(
          /https?:\/\/[^\s'"]*googletagmanager\.com\/gtm\.js[^\s'"]*/
        );
        if (urlMatch) {
          tagManagerUrl = urlMatch[0];
        }
      }

      // Check if in <head>
      const parent = $(el).closest("head");
      if (parent.length > 0) {
        gtmInHead = true;
      }
    }

    // gtag.js: script src containing "googletagmanager.com/gtag/js?id="
    if (
      src.includes("googletagmanager.com/gtag/js") ||
      content.includes("googletagmanager.com/gtag/js")
    ) {
      const ga4Matches = combined.match(/G-[A-Z0-9]+/g);
      if (ga4Matches) {
        for (const id of ga4Matches) {
          if (!ga4Ids.includes(id)) {
            ga4Ids.push(id);
          }
        }
      }

      // Also check if in <head>
      const parent = $(el).closest("head");
      if (parent.length > 0) {
        gtmInHead = true;
      }
    }
  });

  // Also scan inline scripts for GA4 config calls like gtag('config', 'G-XXXXX')
  $("script").each((_i, el) => {
    const content = $(el).html() || "";
    const configMatches = content.match(/G-[A-Z0-9]+/g);
    if (configMatches && content.includes("gtag")) {
      for (const id of configMatches) {
        if (!ga4Ids.includes(id)) {
          ga4Ids.push(id);
        }
      }
    }
  });

  // Check noscript GTM in body (iframe googletagmanager)
  $("noscript").each((_i, el) => {
    const content = $(el).html() || "";
    if (content.includes("googletagmanager.com/ns.html")) {
      gtmInBodyNoscript = true;
    }
  });

  // Detect duplicates: IDs appearing multiple times in raw HTML
  const allIdsInHtml = result.body.match(/GTM-[A-Z0-9]+/g) || [];
  const ga4IdsInHtml = result.body.match(/G-[A-Z0-9]+/g) || [];
  const allIds = [...allIdsInHtml, ...ga4IdsInHtml];
  const idCounts: Record<string, number> = {};
  for (const id of allIds) {
    idCounts[id] = (idCounts[id] || 0) + 1;
  }
  const duplicateIds = Object.entries(idCounts)
    .filter(([, count]) => count > 2) // > 2 because GTM ID typically appears in both script and noscript
    .map(([id]) => id);

  const gtmPresent = gtmIds.length > 0;
  const gtagPresent = ga4Ids.length > 0;

  // Build issues
  const issues = [];

  if (!gtmPresent && !gtagPresent) {
    issues.push(
      createIssue(
        "error",
        "gtm-missing",
        "No GTM container nor gtag.js snippet found on this page. Tracking is likely not implemented."
      )
    );
  }

  if (gtmPresent && !gtmInBodyNoscript) {
    issues.push(
      createIssue(
        "warning",
        "gtm-noscript",
        "GTM container found but the <noscript> fallback iframe is missing from <body>. Users with JavaScript disabled will not be tracked.",
        gtmIds.join(", ")
      )
    );
  }

  if (duplicateIds.length > 0) {
    issues.push(
      createIssue(
        "warning",
        "duplicate-ids",
        `Duplicate tracking ID(s) detected: ${duplicateIds.join(", ")}. This may cause double-counting of data.`,
        duplicateIds.join(", ")
      )
    );
  }

  if (gtmPresent && !gtmInHead) {
    issues.push(
      createIssue(
        "warning",
        "gtm-placement",
        "GTM script not found in <head>. Google recommends placing the GTM snippet as high as possible in <head> for accurate tracking.",
        gtmIds.join(", ")
      )
    );
  }

  if ((gtmPresent || gtagPresent) && duplicateIds.length === 0) {
    const ids = [...gtmIds, ...ga4Ids].join(", ");
    issues.push(
      createIssue(
        "info",
        "gtm-ok",
        `Tracking snippet(s) correctly detected: ${ids}`,
        ids
      )
    );
  }

  const score = calculateScore(issues);

  return {
    url,
    finalUrl: result.finalUrl,
    status: result.status,
    score,
    summary: `GTM audit de ${url}: ${gtmIds.length} GTM container(s), ${ga4Ids.length} GA4 ID(s), score ${score}/100`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, result.fetchedWith, result.antiBot?.blocked ?? false, result.partial),
    data: {
      gtm_present: gtmPresent,
      gtm_ids: gtmIds,
      gtag_present: gtagPresent,
      ga4_ids: ga4Ids,
      gtm_in_head: gtmInHead,
      gtm_in_body_noscript: gtmInBodyNoscript,
      duplicate_ids: duplicateIds,
      tag_manager_url: tagManagerUrl,
    },
  };
}
