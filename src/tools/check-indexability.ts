import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import { fetchRobotsTxt } from "../utils/robots-parser.js";
import { getSitemapUrl } from "../utils/url-utils.js";
import * as cheerio from "cheerio";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkIndexabilitySchema = {
  url: z.string().url().describe("The page URL to check for indexability"),
};

function parseDirectives(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

async function fetchSitemapUrls(siteUrl: string): Promise<Set<string>> {
  const urls = new Set<string>();

  // Try to get sitemaps from robots.txt
  let sitemapLocations: string[] = [];
  try {
    const robots = await fetchRobotsTxt(siteUrl);
    sitemapLocations = robots.sitemaps;
  } catch {
    // ignore
  }

  // Fallback: try default sitemap.xml
  if (sitemapLocations.length === 0) {
    sitemapLocations = [getSitemapUrl(siteUrl)];
  }

  // Only process first sitemap, limit to 1000 URLs for perf
  const sitemapUrl = sitemapLocations[0];
  try {
    const result = await fetchUrl(sitemapUrl, {
      timeout: 10000,
      usePuppeteerFallback: false,
      maxRetries: 0,
    });

    if (result.status === 200) {
      const $ = cheerio.load(result.body, { xmlMode: true });

      // Check if it's a sitemap index
      const indexUrls: string[] = [];
      $("sitemapindex > sitemap > loc").each((_, el) => {
        indexUrls.push($(el).text().trim());
      });

      if (indexUrls.length > 0) {
        // Fetch first sub-sitemap only
        try {
          const subResult = await fetchUrl(indexUrls[0], {
            timeout: 10000,
            usePuppeteerFallback: false,
            maxRetries: 0,
          });
          if (subResult.status === 200) {
            const $sub = cheerio.load(subResult.body, { xmlMode: true });
            let count = 0;
            $sub("urlset > url > loc").each((_, el) => {
              if (count >= 1000) return;
              urls.add($sub(el).text().trim());
              count++;
            });
          }
        } catch {
          // ignore
        }
      } else {
        let count = 0;
        $("urlset > url > loc").each((_, el) => {
          if (count >= 1000) return;
          urls.add($(el).text().trim());
          count++;
        });
      }
    }
  } catch {
    // Sitemap not available
  }

  return urls;
}

export async function checkIndexability({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();

  const result = await fetchUrl(url);
  const $ = cheerio.load(result.body);

  // HTTP status
  const httpStatus = result.status;

  // Meta robots
  const metaRobotsEl = $('meta[name="robots"]');
  const metaRobotsContent = metaRobotsEl.length > 0
    ? (metaRobotsEl.attr("content") || null)
    : null;
  const metaDirectives = parseDirectives(metaRobotsContent);

  // X-Robots-Tag
  const xRobotsContent = result.headers["x-robots-tag"] || null;
  const xRobotsDirectives = parseDirectives(xRobotsContent);

  // All directives combined
  const allDirectives = [...metaDirectives, ...xRobotsDirectives];
  const hasNoindex = allDirectives.includes("noindex") || allDirectives.includes("none");
  const hasNofollow = allDirectives.includes("nofollow") || allDirectives.includes("none");

  // Canonical
  const canonicalEl = $('link[rel="canonical"]');
  const canonicalHref = canonicalEl.length > 0
    ? (canonicalEl.attr("href") || null)
    : null;

  let isSelfReferencing = false;
  let isCrossDomain = false;

  if (canonicalHref) {
    try {
      const canonicalUrl = new URL(canonicalHref, result.finalUrl);
      const pageUrl = new URL(result.finalUrl);
      isSelfReferencing = canonicalUrl.href === pageUrl.href;
      isCrossDomain = canonicalUrl.hostname !== pageUrl.hostname;
    } catch {
      // Invalid canonical URL
    }
  }

  const canonicalPointsElsewhere = canonicalHref !== null && !isSelfReferencing;

  // Hreflang
  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const lang = $(el).attr("hreflang") || "";
    const href = $(el).attr("href") || "";
    if (lang && href) {
      hreflang.push({ lang, href });
    }
  });

  // Check if URL is in sitemap
  let inSitemap: boolean | null = null;
  try {
    const sitemapUrls = await fetchSitemapUrls(url);
    if (sitemapUrls.size > 0) {
      // Normalize for comparison
      const normalizedUrl = result.finalUrl;
      inSitemap = sitemapUrls.has(normalizedUrl) || sitemapUrls.has(url);
    }
  } catch {
    inSitemap = null;
  }

  // Determine indexability
  let indexable = true;
  let indexableReason = "Page is indexable";

  if (httpStatus !== 200) {
    indexable = false;
    indexableReason = `Non-200 status code: ${httpStatus}`;
  } else if (hasNoindex) {
    indexable = false;
    const source = metaDirectives.includes("noindex") || metaDirectives.includes("none")
      ? "meta robots"
      : "X-Robots-Tag";
    indexableReason = `noindex directive found in ${source}`;
  } else if (canonicalPointsElsewhere) {
    indexable = false;
    indexableReason = `Canonical points to a different URL: ${canonicalHref}`;
  }

  // Build issues
  const issues = [];

  if (httpStatus !== 200) {
    issues.push(createIssue("error", "http-status", `HTTP status ${httpStatus} — page may not be indexable`, `${httpStatus}`));
  } else {
    issues.push(createIssue("info", "http-status", `HTTP status 200 OK`));
  }

  if (hasNoindex) {
    issues.push(createIssue("error", "noindex", `noindex directive found — page will not be indexed`, metaRobotsContent || xRobotsContent || undefined));
  }

  if (hasNofollow) {
    issues.push(createIssue("warning", "nofollow", `nofollow directive found — links on this page will not be followed`, metaRobotsContent || xRobotsContent || undefined));
  }

  if (canonicalPointsElsewhere) {
    issues.push(createIssue("error", "canonical", `Canonical points to a different URL: ${canonicalHref}`, canonicalHref ?? undefined));
  } else if (!canonicalHref) {
    issues.push(createIssue("info", "canonical", "No canonical tag found — consider adding a self-referencing canonical"));
  } else if (isSelfReferencing) {
    issues.push(createIssue("info", "canonical", `Self-referencing canonical: ${canonicalHref}`));
  }

  if (isCrossDomain) {
    issues.push(createIssue("warning", "canonical-cross-domain", `Canonical points to a different domain: ${canonicalHref}`, canonicalHref ?? undefined));
  }

  if (inSitemap === false) {
    issues.push(createIssue("warning", "sitemap", "URL not found in the sitemap"));
  } else if (inSitemap === true) {
    issues.push(createIssue("info", "sitemap", "URL found in the sitemap"));
  } else {
    issues.push(createIssue("info", "sitemap", "Could not check sitemap (not available or too large)"));
  }

  // Score
  let score = 100;
  if (hasNoindex) score -= 40;
  if (httpStatus !== 200) score -= 30;
  if (canonicalPointsElsewhere) score -= 20;
  if (inSitemap === false) score -= 10;
  if (!canonicalHref) score -= 5;
  score = Math.max(0, score);

  return {
    url,
    finalUrl: result.finalUrl,
    status: httpStatus,
    score,
    summary: `Indexabilité de ${url}: ${indexable ? "indexable" : "non indexable"} — ${indexableReason}`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(
      startTime,
      result.fetchedWith,
      result.fetchedWith === "puppeteer",
      result.partial
    ),
    data: {
      indexable,
      indexableReason,
      httpStatus,
      metaRobots: {
        content: metaRobotsContent,
        directives: metaDirectives,
      },
      xRobotsTag: {
        content: xRobotsContent,
        directives: xRobotsDirectives,
      },
      canonical: {
        href: canonicalHref,
        isSelfReferencing,
        isCrossDomain,
      },
      hreflang,
      inSitemap,
    },
  };
}
