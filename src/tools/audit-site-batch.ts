import { z } from "zod";
import { fetchUrl, sleep, jitter } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractImages,
  extractJsonLd,
} from "../utils/html-parser.js";
import { parseSitemap } from "./parse-sitemap.js";
import { crawlSite } from "./crawl-site.js";
import {
  type StandardResponse,
  type ToolIssue,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const auditSiteBatchSchema = {
  url: z.string().url().describe("The site URL to audit"),
  source: z
    .enum(["sitemap", "crawl", "urls"])
    .default("sitemap")
    .describe("Source of URLs: sitemap, crawl, or a provided list"),
  urls: z
    .array(z.string().url())
    .optional()
    .describe("List of URLs to audit (only used when source = 'urls')"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Max pages to audit"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(2)
    .describe("Pages audited in parallel"),
  delay: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(500)
    .describe("Delay in ms between batches"),
};

interface PageAuditResult {
  url: string;
  score: number;
  issues: string[];
  issueTypes: string[];
}

interface TopProblem {
  problem: string;
  count: number;
  percentage: string;
  severity: "error" | "warning" | "info";
  affectedUrls: string[];
}

interface QuickWin {
  url: string;
  currentScore: number;
  potentialScore: number;
  fixes: string[];
}

interface CriticalPage {
  url: string;
  score: number;
  issues: string[];
}

function auditSinglePage(
  html: string,
  baseUrl: string,
  pageUrl: string
): PageAuditResult {
  const metadata = extractMetadata(html, baseUrl);
  const headings = extractHeadings(html);
  const images = extractImages(html, baseUrl);
  const jsonLd = extractJsonLd(html);

  const issues: string[] = [];
  const issueTypes: string[] = [];
  let score = 100;

  // Title
  if (!metadata.title) {
    issues.push("Missing title tag");
    issueTypes.push("missing_title");
    score -= 15;
  } else if (metadata.title.length < 10) {
    issues.push(`Title too short (${metadata.title.length} chars)`);
    issueTypes.push("short_title");
    score -= 5;
  } else if (metadata.title.length > 60) {
    issues.push(`Title too long (${metadata.title.length} chars)`);
    issueTypes.push("long_title");
    score -= 5;
  }

  // Description
  if (!metadata.description) {
    issues.push("Missing meta description");
    issueTypes.push("missing_description");
    score -= 15;
  } else if (metadata.description.length < 50) {
    issues.push(`Description too short (${metadata.description.length} chars)`);
    issueTypes.push("short_description");
    score -= 5;
  } else if (metadata.description.length > 160) {
    issues.push(`Description too long (${metadata.description.length} chars)`);
    issueTypes.push("long_description");
    score -= 5;
  }

  // H1
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    issues.push("Missing H1 heading");
    issueTypes.push("missing_h1");
    score -= 10;
  } else if (h1s.length > 1) {
    issues.push(`Multiple H1 headings (${h1s.length})`);
    issueTypes.push("multiple_h1");
    score -= 5;
  }

  // Canonical
  if (!metadata.canonical) {
    issues.push("Missing canonical tag");
    issueTypes.push("missing_canonical");
    score -= 5;
  }

  // Lang
  if (!metadata.lang) {
    issues.push("Missing lang attribute");
    issueTypes.push("missing_lang");
    score -= 5;
  }

  // Images alt
  const imagesWithoutAlt = images.filter((i) => !i.alt);
  if (imagesWithoutAlt.length > 0) {
    issues.push(`${imagesWithoutAlt.length} image(s) missing alt`);
    issueTypes.push("missing_alt");
    score -= Math.min(15, imagesWithoutAlt.length * 3);
  }

  // JSON-LD
  if (jsonLd.length === 0) {
    issues.push("No JSON-LD structured data");
    issueTypes.push("no_json_ld");
    score -= 5;
  }

  // OG tags
  if (Object.keys(metadata.ogTags).length === 0) {
    issues.push("No Open Graph tags");
    issueTypes.push("no_og_tags");
    score -= 5;
  }

  // Twitter tags
  if (Object.keys(metadata.twitterTags).length === 0) {
    issueTypes.push("no_twitter_card");
    // Don't add to issues text, minor
  }

  return {
    url: pageUrl,
    score: Math.max(0, score),
    issues,
    issueTypes,
  };
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
    const result = await parseSitemap({ url });
    const entries = (result.data.entries as Array<{ loc: string }>) || [];
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

export async function auditSiteBatch({
  url,
  source,
  urls,
  limit,
  concurrency,
  delay,
}: {
  url: string;
  source: "sitemap" | "crawl" | "urls";
  urls?: string[];
  limit: number;
  concurrency: number;
  delay: number;
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
      summary: `Audit batch de ${url}: aucune page trouvée via ${source}`,
      issues: [createIssue("error", "no-pages", `No pages found via ${source}`)],
      recommendations: ["Verify the sitemap exists or try source='crawl'"],
      meta: createMeta(startTime, "fetch", false, false),
      data: {
        source,
        pagesAudited: 0,
        scoreAverage: 0,
        scoreMedian: 0,
        distribution: { excellent: 0, bon: 0, moyen: 0, mauvais: 0 },
        topProblems: [],
        quickWins: [],
        criticalPages: [],
        allPages: [],
      },
    };
  }

  // 2. Audit each URL
  const allResults: PageAuditResult[] = [];

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
          return auditSinglePage(fetchResult.body, fetchResult.finalUrl, pageUrl);
        } catch {
          return {
            url: pageUrl,
            score: 0,
            issues: ["Failed to fetch page"],
            issueTypes: ["fetch_error"],
          };
        }
      })
    );
    allResults.push(...batchResults);
  }

  // 3. Aggregate
  const scores = allResults.map((r) => r.score);
  const scoreAverage = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const scoreMedian = median(scores);

  const distribution = {
    excellent: scores.filter((s) => s >= 90).length,
    bon: scores.filter((s) => s >= 70 && s < 90).length,
    moyen: scores.filter((s) => s >= 50 && s < 70).length,
    mauvais: scores.filter((s) => s < 50).length,
  };

  // 4. Top problems
  const problemMap = new Map<string, { urls: string[]; severity: "error" | "warning" | "info" }>();
  const severityMap: Record<string, "error" | "warning" | "info"> = {
    missing_title: "error",
    short_title: "warning",
    long_title: "warning",
    missing_description: "error",
    short_description: "warning",
    long_description: "warning",
    missing_h1: "error",
    multiple_h1: "warning",
    missing_canonical: "warning",
    missing_lang: "warning",
    missing_alt: "warning",
    no_json_ld: "info",
    no_og_tags: "info",
    no_twitter_card: "info",
    fetch_error: "error",
  };

  const labelMap: Record<string, string> = {
    missing_title: "Missing title tag",
    short_title: "Title too short",
    long_title: "Title too long",
    missing_description: "Missing meta description",
    short_description: "Description too short",
    long_description: "Description too long",
    missing_h1: "Missing H1 heading",
    multiple_h1: "Multiple H1 headings",
    missing_canonical: "Missing canonical tag",
    missing_lang: "Missing lang attribute",
    missing_alt: "Images missing alt text",
    no_json_ld: "No JSON-LD structured data",
    no_og_tags: "No Open Graph tags",
    no_twitter_card: "No Twitter Card tags",
    fetch_error: "Failed to fetch page",
  };

  for (const result of allResults) {
    for (const issueType of result.issueTypes) {
      if (!problemMap.has(issueType)) {
        problemMap.set(issueType, { urls: [], severity: severityMap[issueType] || "info" });
      }
      problemMap.get(issueType)!.urls.push(result.url);
    }
  }

  const topProblems: TopProblem[] = [...problemMap.entries()]
    .map(([key, val]) => ({
      problem: labelMap[key] || key,
      count: val.urls.length,
      percentage: `${Math.round((val.urls.length / allResults.length) * 100)}%`,
      severity: val.severity,
      affectedUrls: val.urls.slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 5. Quick wins
  const easyFixes = new Set(["missing_description", "missing_canonical", "missing_alt"]);
  const fixLabels: Record<string, string> = {
    missing_description: "Add meta description",
    missing_canonical: "Add canonical tag",
    missing_alt: "Add alt text to images",
  };

  const quickWins: QuickWin[] = allResults
    .filter((r) => r.score > 60)
    .map((r) => {
      const fixes = r.issueTypes
        .filter((t) => easyFixes.has(t))
        .map((t) => fixLabels[t] || t);
      if (fixes.length === 0 || fixes.length > 2) return null;
      const potentialGain = fixes.length * 10;
      return {
        url: r.url,
        currentScore: r.score,
        potentialScore: Math.min(100, r.score + potentialGain),
        fixes,
      };
    })
    .filter((qw): qw is QuickWin => qw !== null)
    .sort((a, b) => (b.potentialScore - b.currentScore) - (a.potentialScore - a.currentScore))
    .slice(0, 10);

  // 6. Critical pages
  const criticalPages: CriticalPage[] = [...allResults]
    .sort((a, b) => a.score - b.score)
    .slice(0, 10)
    .map((r) => ({
      url: r.url,
      score: r.score,
      issues: r.issues,
    }));

  // Build issues for StandardResponse
  const issues: ToolIssue[] = [];

  if (distribution.mauvais > 0) {
    issues.push(createIssue("error", "distribution", `${distribution.mauvais} page(s) scored below 50`, `${Math.round((distribution.mauvais / allResults.length) * 100)}% of pages`));
  }

  if (topProblems.length > 0) {
    const top = topProblems[0];
    issues.push(createIssue(
      top.severity,
      "top-problem",
      `Most common issue: ${top.problem} (${top.count} pages, ${top.percentage})`,
    ));
  }

  if (scoreAverage < 50) {
    issues.push(createIssue("error", "site-score", `Site average score is critically low: ${scoreAverage}/100`));
  } else if (scoreAverage < 70) {
    issues.push(createIssue("warning", "site-score", `Site average score needs improvement: ${scoreAverage}/100`));
  } else {
    issues.push(createIssue("info", "site-score", `Site average score: ${scoreAverage}/100`));
  }

  const topProblemLabel = topProblems.length > 0
    ? `${topProblems[0].count} pages avec ${topProblems[0].problem}`
    : "aucun problème récurrent";

  return {
    url,
    finalUrl: url,
    status: 200,
    score: scoreAverage,
    summary: `Audit batch de ${url}: ${allResults.length} pages, score moyen ${scoreAverage}/100, ${topProblemLabel}`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      source,
      pagesAudited: allResults.length,
      scoreAverage,
      scoreMedian,
      distribution,
      topProblems,
      quickWins,
      criticalPages,
      allPages: allResults.map((r) => ({
        url: r.url,
        score: r.score,
        issues: r.issues,
      })),
    },
  };
}
