import { z } from "zod";
import * as cheerio from "cheerio";
import { fetchUrl } from "../utils/fetcher.js";
import { getSitemapUrl } from "../utils/url-utils.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const parseSitemapSchema = {
  url: z
    .string()
    .url()
    .describe(
      "The URL of the sitemap.xml or the website root (will auto-detect /sitemap.xml)"
    ),
};

interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: string | null;
}

async function parseSingleSitemap(url: string): Promise<{
  entries: SitemapEntry[];
  sitemapIndexUrls: string[];
}> {
  const result = await fetchUrl(url, { timeout: 15000 });

  if (result.status !== 200) {
    throw new Error(`Sitemap returned status ${result.status}`);
  }

  const $ = cheerio.load(result.body, { xmlMode: true });

  const sitemapIndexUrls: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    sitemapIndexUrls.push($(el).text().trim());
  });

  if (sitemapIndexUrls.length > 0) {
    return { entries: [], sitemapIndexUrls };
  }

  const entries: SitemapEntry[] = [];
  $("urlset > url").each((_, el) => {
    const loc = $("loc", el).text().trim();
    if (!loc) return;

    entries.push({
      loc,
      lastmod: $("lastmod", el).text().trim() || null,
      changefreq: $("changefreq", el).text().trim() || null,
      priority: $("priority", el).text().trim() || null,
    });
  });

  return { entries, sitemapIndexUrls: [] };
}

export async function parseSitemap({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();

  let sitemapUrl = url;
  if (!url.includes("sitemap") && !url.endsWith(".xml")) {
    sitemapUrl = getSitemapUrl(url);
  }

  const allEntries: SitemapEntry[] = [];
  const processedSitemaps: string[] = [];
  const errors: Array<{ url: string; error: string }> = [];
  const queue = [sitemapUrl];

  while (queue.length > 0 && processedSitemaps.length < 50) {
    const currentUrl = queue.shift()!;
    if (processedSitemaps.includes(currentUrl)) continue;
    processedSitemaps.push(currentUrl);

    try {
      const { entries, sitemapIndexUrls } =
        await parseSingleSitemap(currentUrl);
      allEntries.push(...entries);
      queue.push(...sitemapIndexUrls);
    } catch (error) {
      errors.push({
        url: currentUrl,
        error: (error as Error).message,
      });
    }
  }

  const truncated = allEntries.length > 500;

  // Build issues
  const issues = [];

  for (const err of errors) {
    issues.push(createIssue("error", "sitemap-parse", `Failed to parse ${err.url}: ${err.error}`, err.url));
  }

  if (truncated) {
    issues.push(createIssue("warning", "sitemap-truncated", `Results truncated: ${allEntries.length} URLs found, returning first 500`));
  }

  issues.push(createIssue("info", "sitemap-processed", `${processedSitemaps.length} sitemap(s) processed`));

  // Score: 100 base, -20 per error, -5 if truncated
  let score = 100;
  score -= errors.length * 20;
  if (truncated) score -= 5;
  score = Math.max(0, score);

  return {
    url,
    finalUrl: sitemapUrl,
    status: errors.length === processedSitemaps.length ? 0 : 200,
    score,
    summary: `Sitemap de ${url}: ${allEntries.length} URLs dans ${processedSitemaps.length} sitemaps`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      sitemapUrl,
      sitemapsProcessed: processedSitemaps.length,
      totalUrls: allEntries.length,
      entries: allEntries.slice(0, 500),
      errors: errors.length > 0 ? errors : undefined,
      truncated,
    },
  };
}
