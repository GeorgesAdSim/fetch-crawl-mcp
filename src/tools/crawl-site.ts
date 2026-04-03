import { z } from "zod";
import { fetchUrl, jitter, sleep } from "../utils/fetcher.js";
import { extractLinks, extractMetadata } from "../utils/html-parser.js";
import { normalizeUrl, isInternalUrl } from "../utils/url-utils.js";
import {
  fetchRobotsTxt,
  isAllowedByRobots,
} from "../utils/robots-parser.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const crawlSiteSchema = {
  url: z.string().url().describe("The starting URL to crawl"),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2)
    .describe("Maximum crawl depth (0 = only the starting page)"),
  maxPages: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Maximum number of pages to crawl"),
  delay: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(300)
    .describe(
      "Base delay in ms between requests. A random jitter of ±30% is applied automatically (default: 300ms)"
    ),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe(
      "Number of pages to fetch in parallel (default: 3). Lower values are safer for small sites"
    ),
  respectRobotsTxt: z
    .boolean()
    .default(true)
    .describe("Respect robots.txt rules and Crawl-delay (default: true)"),
  includePattern: z
    .string()
    .optional()
    .describe("Regex pattern: only crawl URLs matching this pattern"),
  excludePattern: z
    .string()
    .optional()
    .describe("Regex pattern: skip URLs matching this pattern"),
};

interface CrawledPage {
  url: string;
  title: string;
  status: number;
  depth: number;
  linksFound: number;
  fetchedWith: "fetch" | "puppeteer";
  error?: string;
}

const CRAWL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function crawlOne(
  normalizedUrl: string,
  depth: number,
  baseUrl: string
): Promise<{
  page: CrawledPage;
  newLinks: Array<{ url: string; depth: number }>;
}> {
  try {
    const result = await fetchUrl(normalizedUrl, { timeout: 15000 });
    const contentType = result.headers["content-type"] || "";

    if (!contentType.includes("text/html")) {
      return {
        page: {
          url: normalizedUrl,
          title: "",
          status: result.status,
          depth,
          linksFound: 0,
          fetchedWith: result.fetchedWith,
        },
        newLinks: [],
      };
    }

    const metadata = extractMetadata(result.body, result.finalUrl);
    const links = extractLinks(result.body, result.finalUrl);
    const internalLinks = links.filter((l) =>
      isInternalUrl(baseUrl, l.href)
    );

    return {
      page: {
        url: normalizedUrl,
        title: metadata.title,
        status: result.status,
        depth,
        linksFound: internalLinks.length,
        fetchedWith: result.fetchedWith,
      },
      newLinks: internalLinks.map((l) => ({
        url: normalizeUrl(l.href),
        depth: depth + 1,
      })),
    };
  } catch (error) {
    return {
      page: {
        url: normalizedUrl,
        title: "",
        status: 0,
        depth,
        linksFound: 0,
        fetchedWith: "fetch",
        error: (error as Error).message,
      },
      newLinks: [],
    };
  }
}

export async function crawlSite({
  url,
  maxDepth,
  maxPages,
  delay,
  concurrency,
  respectRobotsTxt,
  includePattern,
  excludePattern,
}: {
  url: string;
  maxDepth: number;
  maxPages: number;
  delay: number;
  concurrency: number;
  respectRobotsTxt: boolean;
  includePattern?: string;
  excludePattern?: string;
}): Promise<StandardResponse> {
  const startTime = performance.now();
  const startedAt = new Date().toISOString();
  const visited = new Set<string>();
  const results: CrawledPage[] = [];
  const queue: Array<{ url: string; depth: number }> = [
    { url: normalizeUrl(url), depth: 0 },
  ];

  const includeRegex = includePattern ? new RegExp(includePattern) : null;
  const excludeRegex = excludePattern ? new RegExp(excludePattern) : null;

  let disallowed: string[] = [];
  let robotsCrawlDelay: number | null = null;
  let robotsSitemaps: string[] = [];

  if (respectRobotsTxt) {
    const robots = await fetchRobotsTxt(url);
    disallowed = robots.disallowed;
    robotsCrawlDelay = robots.crawlDelay;
    robotsSitemaps = robots.sitemaps;

    if (robotsCrawlDelay !== null && robotsCrawlDelay * 1000 > delay) {
      console.error(
        `robots.txt Crawl-delay: ${robotsCrawlDelay}s — overriding delay to ${robotsCrawlDelay * 1000}ms`
      );
      delay = robotsCrawlDelay * 1000;
    }
  }

  function pickBatch(size: number): Array<{ url: string; depth: number }> {
    const batch: Array<{ url: string; depth: number }> = [];
    while (queue.length > 0 && batch.length < size) {
      const item = queue.shift()!;
      const norm = normalizeUrl(item.url);

      if (visited.has(norm)) continue;
      if (includeRegex && !includeRegex.test(norm)) continue;
      if (excludeRegex && excludeRegex.test(norm)) continue;
      if (respectRobotsTxt && !isAllowedByRobots(norm, disallowed)) {
        console.error(`Blocked by robots.txt: ${norm}`);
        continue;
      }

      visited.add(norm);
      batch.push({ url: norm, depth: item.depth });
    }
    return batch;
  }

  let isFirstBatch = true;
  let abortedEarly = false;
  let abortReason: string | undefined;

  while (queue.length > 0 && results.length < maxPages) {
    // Check 5-minute timeout
    const elapsed = performance.now() - startTime;
    if (elapsed > CRAWL_TIMEOUT_MS) {
      abortedEarly = true;
      abortReason = "timeout 5min";
      break;
    }

    if (!isFirstBatch && delay > 0) {
      await sleep(jitter(delay));
    }
    isFirstBatch = false;

    const slotsLeft = maxPages - results.length;
    const batchSize = Math.min(concurrency, slotsLeft);
    const batch = pickBatch(batchSize);

    if (batch.length === 0) break;

    const batchResults = await Promise.all(
      batch.map(({ url: batchUrl, depth }) =>
        crawlOne(batchUrl, depth, url)
      )
    );

    for (const { page, newLinks } of batchResults) {
      if (page.status === 429) {
        console.error(`Rate limited on ${page.url}, backing off`);
        await sleep(jitter(5000));
        visited.delete(page.url);
        queue.unshift({ url: page.url, depth: page.depth });
        continue;
      }

      results.push(page);

      if (page.depth < maxDepth) {
        for (const link of newLinks) {
          if (!visited.has(link.url)) {
            queue.push(link);
          }
        }
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const durationSeconds = Math.round((performance.now() - startTime) / 1000);
  const pagesPerSecond =
    durationSeconds > 0
      ? Math.round((results.length / durationSeconds) * 100) / 100
      : results.length;

  const maxDepthReached = results.length > 0
    ? Math.max(...results.map((r) => r.depth))
    : 0;

  // Build issues
  const issues = [];
  for (const page of results) {
    if (page.status >= 400) {
      issues.push(createIssue(
        "error",
        "page-status",
        `Page ${page.url} returned status ${page.status}`,
        page.error
      ));
    } else if (page.status >= 300 && page.status < 400) {
      issues.push(createIssue(
        "warning",
        "page-redirect",
        `Page ${page.url} returned redirect status ${page.status}`
      ));
    }
  }

  if (abortedEarly) {
    issues.push(createIssue(
      "warning",
      "crawl-aborted",
      `Crawl interrompu prématurément: ${abortReason}. ${results.length} pages crawlées sur ${maxPages} demandées.`
    ));
  }

  const errorPages = results.filter((r) => r.status >= 400).length;
  const errorRatio = results.length > 0 ? errorPages / results.length : 0;
  const score = Math.max(0, Math.round(100 - errorRatio * 100));

  return {
    url,
    finalUrl: url,
    status: results[0]?.status ?? 0,
    score,
    summary: `Crawl de ${url}: ${results.length} pages trouvées, profondeur max ${maxDepthReached}${abortedEarly ? ` (interrompu: ${abortReason})` : ""}`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      startUrl: url,
      pagesFound: results.length,
      maxDepthReached,
      crawlStats: {
        startedAt,
        finishedAt,
        durationSeconds,
        pagesPerSecond,
        abortedEarly,
        abortReason,
      },
      robotsTxt: respectRobotsTxt
        ? {
            disallowedRules: disallowed.length,
            crawlDelay: robotsCrawlDelay,
            sitemapsFound: robotsSitemaps,
          }
        : undefined,
      pages: results,
    },
  };
}
