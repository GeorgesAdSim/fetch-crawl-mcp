import { z } from "zod";
import { fetchUrl, jitter, sleep } from "../utils/fetcher.js";
import { extractLinks } from "../utils/html-parser.js";
import { normalizeUrl, isInternalUrl } from "../utils/url-utils.js";
import { parseSitemap } from "./parse-sitemap.js";
import {
  type StandardResponse,
  type ToolIssue,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const detectOrphanPagesSchema = {
  url: z.string().url().describe("The site URL to analyze"),
  maxCrawlPages: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(100)
    .describe("Max pages to crawl for building the link graph"),
  crawlDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("Crawl depth"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("Pages crawled in parallel"),
  delay: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(300)
    .describe("Delay in ms between batches"),
};

type Category =
  | "orphan_in_sitemap"
  | "orphan_not_in_sitemap"
  | "sitemap_only"
  | "crawl_only"
  | "deep_page"
  | "well_linked";

interface PageNode {
  url: string;
  linksTo: Set<string>;
  linkedFrom: Set<string>;
  depth: number;
  status: number;
}

interface CategoryEntry {
  url: string;
  inboundLinks: number;
  depth?: number;
  source: "sitemap" | "crawl" | "both";
}

async function collectSitemapUrls(baseUrl: string): Promise<Set<string>> {
  const urls = new Set<string>();

  // Try /sitemap.xml first
  try {
    const result = await parseSitemap({ url: baseUrl });
    const entries = (result.data.entries as Array<{ loc: string }>) || [];
    for (const entry of entries.slice(0, 500)) {
      urls.add(normalizeUrl(entry.loc));
    }
  } catch {
    // Try /1_index_sitemap.xml as fallback
    try {
      const origin = new URL(baseUrl).origin;
      const result = await parseSitemap({ url: `${origin}/1_index_sitemap.xml` });
      const entries = (result.data.entries as Array<{ loc: string }>) || [];
      for (const entry of entries.slice(0, 500)) {
        urls.add(normalizeUrl(entry.loc));
      }
    } catch {
      // No sitemap found
    }
  }

  return urls;
}

async function crawlAndBuildGraph(
  baseUrl: string,
  maxPages: number,
  maxDepth: number,
  concurrency: number,
  delay: number
): Promise<Map<string, PageNode>> {
  const graph = new Map<string, PageNode>();
  const visited = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [
    { url: normalizeUrl(baseUrl), depth: 0 },
  ];

  let isFirstBatch = true;

  while (queue.length > 0 && visited.size < maxPages) {
    if (!isFirstBatch && delay > 0) {
      await sleep(jitter(delay));
    }
    isFirstBatch = false;

    const slotsLeft = maxPages - visited.size;
    const batchSize = Math.min(concurrency, slotsLeft);
    const batch: Array<{ url: string; depth: number }> = [];

    while (queue.length > 0 && batch.length < batchSize) {
      const item = queue.shift()!;
      const norm = normalizeUrl(item.url);
      if (visited.has(norm)) continue;
      visited.add(norm);
      batch.push({ url: norm, depth: item.depth });
    }

    if (batch.length === 0) break;

    const batchResults = await Promise.all(
      batch.map(async ({ url, depth }) => {
        try {
          const result = await fetchUrl(url, {
            timeout: 15000,
            maxRetries: 1,
          });
          const contentType = result.headers["content-type"] || "";
          if (!contentType.includes("text/html")) {
            return { url, depth, status: result.status, links: [] as string[] };
          }

          const links = extractLinks(result.body, result.finalUrl);
          const internalLinks = links
            .filter((l) => isInternalUrl(baseUrl, l.href))
            .map((l) => normalizeUrl(l.href));

          return {
            url,
            depth,
            status: result.status,
            links: [...new Set(internalLinks)],
          };
        } catch {
          return { url, depth, status: 0, links: [] as string[] };
        }
      })
    );

    for (const { url, depth, status, links } of batchResults) {
      if (!graph.has(url)) {
        graph.set(url, {
          url,
          linksTo: new Set(),
          linkedFrom: new Set(),
          depth,
          status,
        });
      }
      const node = graph.get(url)!;
      node.depth = depth;
      node.status = status;

      for (const linkTarget of links) {
        node.linksTo.add(linkTarget);

        if (!graph.has(linkTarget)) {
          graph.set(linkTarget, {
            url: linkTarget,
            linksTo: new Set(),
            linkedFrom: new Set(),
            depth: -1,
            status: -1,
          });
        }
        graph.get(linkTarget)!.linkedFrom.add(url);

        if (depth + 1 <= maxDepth && !visited.has(linkTarget)) {
          queue.push({ url: linkTarget, depth: depth + 1 });
        }
      }
    }
  }

  return graph;
}

function classifyUrl(
  inSitemap: boolean,
  node: PageNode | undefined
): Category {
  const inboundLinks = node ? node.linkedFrom.size : 0;
  const depth = node?.depth ?? -1;
  const wasCrawled = node !== undefined && node.status > 0;

  if (inSitemap && wasCrawled && inboundLinks >= 2) {
    return "well_linked";
  }

  if (inSitemap && inboundLinks === 0) {
    if (!wasCrawled) return "sitemap_only";
    return "orphan_in_sitemap";
  }

  if (inSitemap && !wasCrawled) {
    return "sitemap_only";
  }

  if (!inSitemap && wasCrawled) {
    if (inboundLinks <= 1) return "orphan_not_in_sitemap";
    return "crawl_only";
  }

  if (wasCrawled && depth >= 4) {
    return "deep_page";
  }

  if (!inSitemap && !wasCrawled && inboundLinks <= 1) {
    return "orphan_not_in_sitemap";
  }

  if (inSitemap && wasCrawled && inboundLinks === 1) {
    // 1 inbound + in sitemap: not quite orphan, but close — classify as well_linked for now
    return "well_linked";
  }

  return "well_linked";
}

export async function detectOrphanPages({
  url,
  maxCrawlPages,
  crawlDepth,
  concurrency,
  delay,
}: {
  url: string;
  maxCrawlPages: number;
  crawlDepth: number;
  concurrency: number;
  delay: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  // 1. Collect from sitemap and crawl in parallel
  const [sitemapUrls, graph] = await Promise.all([
    collectSitemapUrls(url),
    crawlAndBuildGraph(url, maxCrawlPages, crawlDepth, concurrency, delay),
  ]);

  // 2. Build union of all URLs
  const allUrls = new Set<string>();
  for (const u of sitemapUrls) allUrls.add(u);
  for (const u of graph.keys()) allUrls.add(u);

  // Crawled URLs = pages we actually fetched (status > 0, depth >= 0)
  const crawledUrls = new Set<string>();
  for (const [u, node] of graph) {
    if (node.status > 0 && node.depth >= 0) {
      crawledUrls.add(u);
    }
  }

  // 3. Classify each URL
  const categories: Record<Category, CategoryEntry[]> = {
    orphan_in_sitemap: [],
    orphan_not_in_sitemap: [],
    sitemap_only: [],
    crawl_only: [],
    deep_page: [],
    well_linked: [],
  };

  for (const pageUrl of allUrls) {
    const inSitemap = sitemapUrls.has(pageUrl);
    const inCrawl = crawledUrls.has(pageUrl);
    const node = graph.get(pageUrl);

    let category = classifyUrl(inSitemap, node);

    // Override: check deep_page for pages that are well_linked but too deep
    if (category === "well_linked" && node && node.depth >= 4) {
      category = "deep_page";
    }

    const entry: CategoryEntry = {
      url: pageUrl,
      inboundLinks: node ? node.linkedFrom.size : 0,
      depth: node && node.depth >= 0 ? node.depth : undefined,
      source: inSitemap && inCrawl ? "both" : inSitemap ? "sitemap" : "crawl",
    };

    categories[category].push(entry);
  }

  // 4. Stats
  const overlap = [...sitemapUrls].filter((u) => crawledUrls.has(u)).length;
  const totalUrlsUnion = allUrls.size;
  const overlapPercentage =
    totalUrlsUnion > 0 ? Math.round((overlap / totalUrlsUnion) * 100) : 0;

  const orphanCount =
    categories.orphan_in_sitemap.length +
    categories.orphan_not_in_sitemap.length;

  const stats = {
    totalUrlsSitemap: sitemapUrls.size,
    totalUrlsCrawled: crawledUrls.size,
    totalUrlsUnion,
    overlap,
    overlapPercentage,
  };

  // 5. Score
  let score = 100;
  score -= Math.min(40, categories.orphan_in_sitemap.length * 2 + categories.orphan_not_in_sitemap.length * 2);
  score -= Math.min(20, categories.sitemap_only.length * 1);
  score -= Math.min(15, categories.crawl_only.length * 1);
  score -= Math.min(10, Math.floor(categories.deep_page.length * 0.5));
  if (overlapPercentage < 50) score -= 15;
  score = Math.max(0, score);

  // 6. Issues
  const issues: ToolIssue[] = [];

  if (categories.orphan_in_sitemap.length > 0) {
    issues.push(createIssue(
      "error",
      "orphan-in-sitemap",
      `${categories.orphan_in_sitemap.length} page(s) dans le sitemap sans aucun lien interne (orphelines critiques)`
    ));
  }

  if (categories.orphan_not_in_sitemap.length > 0) {
    issues.push(createIssue(
      "error",
      "orphan-not-in-sitemap",
      `${categories.orphan_not_in_sitemap.length} page(s) isolées (hors sitemap, 0-1 lien interne)`
    ));
  }

  if (categories.sitemap_only.length > 0) {
    issues.push(createIssue(
      "warning",
      "sitemap-only",
      `${categories.sitemap_only.length} page(s) dans le sitemap mais non atteintes par le crawl`
    ));
  }

  if (categories.crawl_only.length > 0) {
    issues.push(createIssue(
      "warning",
      "crawl-only",
      `${categories.crawl_only.length} page(s) trouvées par le crawl mais absentes du sitemap`
    ));
  }

  if (categories.deep_page.length > 0) {
    issues.push(createIssue(
      "warning",
      "deep-pages",
      `${categories.deep_page.length} page(s) à profondeur >= 4 (trop profondes pour un bon SEO)`
    ));
  }

  if (overlapPercentage < 50) {
    issues.push(createIssue(
      "error",
      "low-overlap",
      `Cohérence sitemap/crawl faible: seulement ${overlapPercentage}% de recouvrement`
    ));
  }

  if (sitemapUrls.size === 0) {
    issues.push(createIssue(
      "warning",
      "no-sitemap",
      "Aucun sitemap trouvé — impossible de détecter les orphelines sitemap"
    ));
  }

  // 7. Build output categories (max 20 per category)
  const sortByInbound = (a: CategoryEntry, b: CategoryEntry) =>
    a.inboundLinks - b.inboundLinks;

  const outputCategories: Record<string, { count: number; urls?: CategoryEntry[] }> = {
    orphan_in_sitemap: {
      count: categories.orphan_in_sitemap.length,
      urls: categories.orphan_in_sitemap.sort(sortByInbound).slice(0, 20),
    },
    orphan_not_in_sitemap: {
      count: categories.orphan_not_in_sitemap.length,
      urls: categories.orphan_not_in_sitemap.sort(sortByInbound).slice(0, 20),
    },
    sitemap_only: {
      count: categories.sitemap_only.length,
      urls: categories.sitemap_only.slice(0, 20),
    },
    crawl_only: {
      count: categories.crawl_only.length,
      urls: categories.crawl_only.slice(0, 20),
    },
    deep_page: {
      count: categories.deep_page.length,
      urls: categories.deep_page.slice(0, 20),
    },
    well_linked: {
      count: categories.well_linked.length,
    },
  };

  // 8. Link graph: top 20 pages by inbound links
  const linkGraph = [...graph.entries()]
    .filter(([, node]) => node.status > 0)
    .map(([u, node]) => ({
      url: u,
      inboundLinks: node.linkedFrom.size,
      outboundLinks: node.linksTo.size,
    }))
    .sort((a, b) => b.inboundLinks - a.inboundLinks)
    .slice(0, 20);

  // 9. Top orphan pages
  const allOrphans = [
    ...categories.orphan_in_sitemap,
    ...categories.orphan_not_in_sitemap,
  ];
  const topOrphanPages = allOrphans
    .sort((a, b) => a.inboundLinks - b.inboundLinks)
    .slice(0, 10)
    .map((entry) => ({
      url: entry.url,
      source: entry.source,
      inboundLinks: entry.inboundLinks,
      depth: entry.depth,
      category: sitemapUrls.has(entry.url) ? "orphan_in_sitemap" : "orphan_not_in_sitemap",
    }));

  return {
    url,
    finalUrl: url,
    status: 200,
    score,
    summary: `Analyse d'orphelines de ${url}: ${totalUrlsUnion} URLs, ${orphanCount} orphelines, ${overlapPercentage}% de cohérence sitemap/crawl`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      stats,
      categories: outputCategories,
      linkGraph,
      topOrphanPages,
    },
  };
}
