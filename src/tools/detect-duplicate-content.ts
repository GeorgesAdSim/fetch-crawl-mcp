import { z } from "zod";
import { fetchUrl, sleep, jitter } from "../utils/fetcher.js";
import { extractMetadata, extractHeadings, extractTextContent } from "../utils/html-parser.js";
import { parseSitemap } from "./parse-sitemap.js";
import { crawlSite } from "./crawl-site.js";
import {
  type StandardResponse,
  type ToolIssue,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const detectDuplicateContentSchema = {
  url: z.string().url().describe("The site URL to analyze"),
  source: z
    .enum(["sitemap", "crawl", "urls"])
    .default("crawl")
    .describe("Source of URLs: sitemap, crawl, or a provided list"),
  urls: z
    .array(z.string().url())
    .optional()
    .describe("List of URLs to analyze (only used when source = 'urls')"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Max pages to analyze"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("Pages fetched in parallel"),
  delay: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(300)
    .describe("Delay in ms between batches"),
  similarityThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe("Similarity threshold (0-1) above which pages are considered near-duplicates"),
};

interface PageData {
  url: string;
  title: string;
  description: string;
  h1: string;
  content: string;
  titleNorm: string;
  descNorm: string;
  h1Norm: string;
  contentNorm: string;
}

interface ExactCluster {
  type: "title" | "description" | "h1";
  value: string;
  pages: { url: string; title: string }[];
}

interface NearDuplicateCluster {
  type: "title" | "content";
  similarity: number;
  pages: { url: string; title: string; snippet: string }[];
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "");
}

function wordSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(" ").filter(Boolean));
  const wordsB = new Set(b.split(" ").filter(Boolean));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let common = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) common++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? common / union : 0;
}

function firstNWords(text: string, n: number): string {
  return text.split(" ").slice(0, n).join(" ");
}

async function collectUrls(
  url: string,
  source: "sitemap" | "crawl" | "urls",
  urls: string[] | undefined,
  limit: number
): Promise<string[]> {
  if (source === "urls") {
    return (urls || []).slice(0, limit);
  }

  if (source === "sitemap") {
    let result = await parseSitemap({ url });
    let entries = (result.data.entries as Array<{ loc: string }>) || [];
    if (entries.length === 0) {
      try {
        const origin = new URL(url).origin;
        result = await parseSitemap({ url: `${origin}/1_index_sitemap.xml` });
        entries = (result.data.entries as Array<{ loc: string }>) || [];
      } catch {
        // fallback failed
      }
    }
    return entries.slice(0, limit).map((e) => e.loc);
  }

  // crawl
  const result = await crawlSite({
    url,
    maxDepth: 2,
    maxPages: limit,
    delay: 300,
    concurrency: 3,
    respectRobotsTxt: true,
  });
  const pages = (result.data.pages as Array<{ url: string }>) || [];
  return pages.map((p) => p.url);
}

function findExactDuplicates(pages: PageData[]): ExactCluster[] {
  const clusters: ExactCluster[] = [];

  const groupBy = (
    field: "titleNorm" | "descNorm" | "h1Norm",
    type: "title" | "description" | "h1",
    rawField: "title" | "description" | "h1"
  ) => {
    const groups = new Map<string, PageData[]>();
    for (const page of pages) {
      const val = page[field];
      if (!val) continue;
      if (!groups.has(val)) groups.set(val, []);
      groups.get(val)!.push(page);
    }
    for (const [value, group] of groups) {
      if (group.length >= 2) {
        clusters.push({
          type,
          value: group[0][rawField] || value,
          pages: group.map((p) => ({ url: p.url, title: p.title })),
        });
      }
    }
  };

  groupBy("titleNorm", "title", "title");
  groupBy("descNorm", "description", "description");
  groupBy("h1Norm", "h1", "h1");

  return clusters;
}

function findNearDuplicates(
  pages: PageData[],
  threshold: number
): NearDuplicateCluster[] {
  const clusters: NearDuplicateCluster[] = [];
  const alreadyPaired = new Set<string>();

  const findNear = (
    type: "title" | "content",
    getText: (p: PageData) => string,
    getSnippet: (p: PageData) => string
  ) => {
    // Group by first 3 words to avoid O(n²)
    const buckets = new Map<string, PageData[]>();
    for (const page of pages) {
      const text = getText(page);
      if (!text) continue;
      const key = firstNWords(text, 3);
      if (!key) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(page);
    }

    for (const [, bucket] of buckets) {
      if (bucket.length < 2) continue;

      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i];
          const b = bucket[j];
          const pairKey = `${type}:${a.url}:${b.url}`;
          if (alreadyPaired.has(pairKey)) continue;

          const textA = getText(a);
          const textB = getText(b);
          const sim = wordSimilarity(textA, textB);

          if (sim >= threshold) {
            alreadyPaired.add(pairKey);
            clusters.push({
              type,
              similarity: Math.round(sim * 100) / 100,
              pages: [
                { url: a.url, title: a.title, snippet: getSnippet(a).slice(0, 100) },
                { url: b.url, title: b.title, snippet: getSnippet(b).slice(0, 100) },
              ],
            });
          }
        }
      }
    }
  };

  findNear(
    "title",
    (p) => p.titleNorm,
    (p) => p.title
  );

  findNear(
    "content",
    (p) => p.contentNorm.slice(0, 500),
    (p) => p.content
  );

  return clusters;
}

export async function detectDuplicateContent({
  url,
  source,
  urls,
  limit,
  concurrency,
  delay,
  similarityThreshold,
}: {
  url: string;
  source: "sitemap" | "crawl" | "urls";
  urls?: string[];
  limit: number;
  concurrency: number;
  delay: number;
  similarityThreshold: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  // 1. Collect URLs
  const pageUrls = await collectUrls(url, source, urls, limit);

  if (pageUrls.length === 0) {
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Détection duplicates sur ${url}: aucune page trouvée via ${source}`,
      issues: [createIssue("error", "no-pages", `No pages found via ${source}`)],
      recommendations: ["Verify the sitemap exists or try source='crawl'"],
      meta: createMeta(startTime, "fetch", false, false),
      data: {
        pagesAnalyzed: 0,
        exactDuplicates: [],
        nearDuplicates: [],
        uniquePages: 0,
        stats: {
          pagesAnalyzed: 0,
          exactDuplicateClusters: 0,
          nearDuplicateClusters: 0,
          mostDuplicatedValue: null,
        },
      },
    };
  }

  // 2. Fetch and extract each page
  const allPages: PageData[] = [];

  for (let i = 0; i < pageUrls.length; i += concurrency) {
    if (i > 0 && delay > 0) {
      await sleep(jitter(delay));
    }

    const batch = pageUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (pageUrl) => {
        try {
          const fetchResult = await fetchUrl(pageUrl, {
            timeout: 15000,
            maxRetries: 1,
          });

          const metadata = extractMetadata(fetchResult.body, fetchResult.finalUrl);
          const headings = extractHeadings(fetchResult.body);
          const textContent = extractTextContent(fetchResult.body).slice(0, 2000);
          const h1 = headings.find((h) => h.level === 1)?.text || "";

          return {
            url: pageUrl,
            title: metadata.title,
            description: metadata.description,
            h1,
            content: textContent,
            titleNorm: normalizeText(metadata.title),
            descNorm: normalizeText(metadata.description),
            h1Norm: normalizeText(h1),
            contentNorm: normalizeText(textContent),
          } as PageData;
        } catch {
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result) allPages.push(result);
    }
  }

  // 3. Find duplicates
  const exactDuplicates = findExactDuplicates(allPages);
  const nearDuplicates = findNearDuplicates(allPages, similarityThreshold);

  // 4. Count unique pages (not in any cluster)
  const duplicatedUrls = new Set<string>();
  for (const cluster of exactDuplicates) {
    for (const page of cluster.pages) duplicatedUrls.add(page.url);
  }
  for (const cluster of nearDuplicates) {
    for (const page of cluster.pages) duplicatedUrls.add(page.url);
  }
  const uniquePages = allPages.length - duplicatedUrls.size;

  // 5. Stats
  const mostDuplicated = exactDuplicates.length > 0
    ? exactDuplicates.sort((a, b) => b.pages.length - a.pages.length)[0].value
    : null;

  const stats = {
    pagesAnalyzed: allPages.length,
    exactDuplicateClusters: exactDuplicates.length,
    nearDuplicateClusters: nearDuplicates.length,
    mostDuplicatedValue: mostDuplicated,
  };

  // 6. Score
  let score = 100;
  score -= Math.min(40, exactDuplicates.length * 5);
  score -= Math.min(30, nearDuplicates.length * 2);
  score = Math.max(0, score);

  // 7. Issues
  const issues: ToolIssue[] = [];

  if (exactDuplicates.length > 0) {
    const titleDups = exactDuplicates.filter((c) => c.type === "title").length;
    const descDups = exactDuplicates.filter((c) => c.type === "description").length;
    const h1Dups = exactDuplicates.filter((c) => c.type === "h1").length;

    if (titleDups > 0) {
      issues.push(createIssue("error", "duplicate-titles", `${titleDups} groupe(s) de titles dupliqués`));
    }
    if (descDups > 0) {
      issues.push(createIssue("error", "duplicate-descriptions", `${descDups} groupe(s) de meta descriptions dupliquées`));
    }
    if (h1Dups > 0) {
      issues.push(createIssue("warning", "duplicate-h1", `${h1Dups} groupe(s) de H1 dupliqués`));
    }
  }

  if (nearDuplicates.length > 0) {
    const titleNear = nearDuplicates.filter((c) => c.type === "title").length;
    const contentNear = nearDuplicates.filter((c) => c.type === "content").length;

    if (titleNear > 0) {
      issues.push(createIssue("warning", "near-duplicate-titles", `${titleNear} paire(s) de titles quasi-identiques`));
    }
    if (contentNear > 0) {
      issues.push(createIssue("warning", "near-duplicate-content", `${contentNear} paire(s) de contenus quasi-identiques`));
    }
  }

  if (exactDuplicates.length === 0 && nearDuplicates.length === 0) {
    issues.push(createIssue("info", "no-duplicates", "Aucun contenu dupliqué détecté"));
  }

  return {
    url,
    finalUrl: url,
    status: 200,
    score,
    summary: `Détection duplicates sur ${url}: ${allPages.length} pages, ${exactDuplicates.length} groupes de duplicates exacts, ${nearDuplicates.length} near-duplicates`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      exactDuplicates,
      nearDuplicates,
      uniquePages,
      stats,
    },
  };
}
