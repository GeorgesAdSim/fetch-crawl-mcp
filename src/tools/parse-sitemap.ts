import { z } from "zod";
import * as cheerio from "cheerio";
import { fetchUrl } from "../utils/fetcher.js";
import { getSitemapUrl } from "../utils/url-utils.js";

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

  // Check if it's a sitemap index
  const sitemapIndexUrls: string[] = [];
  $("sitemapindex > sitemap > loc").each((_, el) => {
    sitemapIndexUrls.push($(el).text().trim());
  });

  if (sitemapIndexUrls.length > 0) {
    return { entries: [], sitemapIndexUrls };
  }

  // Parse regular sitemap
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

export async function parseSitemap({ url }: { url: string }) {
  // Detect if URL is a sitemap or a site root
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

  return {
    sitemapUrl,
    sitemapsProcessed: processedSitemaps.length,
    totalUrls: allEntries.length,
    entries: allEntries.slice(0, 500), // Limit output size
    errors: errors.length > 0 ? errors : undefined,
    truncated: allEntries.length > 500,
  };
}
