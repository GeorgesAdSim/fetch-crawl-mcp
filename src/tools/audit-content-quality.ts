import { z } from "zod";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const auditContentQualitySchema = {
  url: z.string().url().describe("The URL of the page to audit"),
  locale: z
    .enum(["auto", "fr", "nl", "en", "de", "es", "it"])
    .default("auto")
    .describe(
      "Language code for readability scoring. 'auto' detects from the HTML lang attribute."
    ),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(15000)
    .default(10000)
    .describe("Request timeout in milliseconds"),
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const EXCLUDED_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  ".sidebar",
  ".widget",
  ".menu",
  ".nav",
  "script",
  "style",
  "noscript",
  "svg",
].join(",");

const FAQ_HEADING_PATTERNS: RegExp[] = [
  /\bFAQ\b/i,
  /frequently\s+asked\s+questions/i,
  /questions\s+fr[eé]quentes/i,
  /veelgestelde\s+vragen/i,
  /h[aä]ufig\s+gestellte\s+fragen/i,
  /preguntas\s+frecuentes/i,
  /domande\s+frequenti/i,
];

const CTA_CLASS_PATTERN =
  /\b(cta|btn-primary|btn-cta|button-primary|call-to-action|buy-now|signup|sign-up|subscribe|btn-action)\b/i;

const SUPPORTED_LOCALES = ["fr", "nl", "en", "de", "es", "it"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

// -------- text helpers --------

function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function countSyllablesEn(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  let stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  stripped = stripped.replace(/^y/, "");
  const matches = stripped.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

export interface ReadabilityResult {
  score: number;
  level: "easy" | "moderate" | "difficult";
  avgSentenceLength: number;
  avgWordLength: number;
}

export function computeReadability(
  text: string,
  locale: Locale
): ReadabilityResult {
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = splitSentences(text);
  const wordCount = words.length;
  const sentenceCount = Math.max(sentences.length, 1);
  const avgSentenceLength = wordCount > 0 ? wordCount / sentenceCount : 0;
  const totalChars = words.reduce(
    (sum, w) => sum + w.replace(/[^\p{L}]/gu, "").length,
    0
  );
  const avgWordLength = wordCount > 0 ? totalChars / wordCount : 0;

  let avgSyllablesPerWord: number;
  if (locale === "en") {
    const totalSyllables = words.reduce(
      (sum, w) => sum + countSyllablesEn(w),
      0
    );
    avgSyllablesPerWord = wordCount > 0 ? totalSyllables / wordCount : 0;
  } else {
    avgSyllablesPerWord = avgWordLength / 3;
  }

  const raw = 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllablesPerWord;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const level: "easy" | "moderate" | "difficult" =
    score >= 60 ? "easy" : score >= 30 ? "moderate" : "difficult";

  return {
    score,
    level,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    avgWordLength: Math.round(avgWordLength * 10) / 10,
  };
}

// -------- structural analyses --------

interface HeadingCounts {
  h1: number;
  h2: number;
  h3: number;
  h4: number;
  h5: number;
  h6: number;
}

interface HeadingAnalysis {
  counts: HeadingCounts;
  total: number;
  hierarchyValid: boolean;
}

function analyzeHeadings(
  $: CheerioAPI,
  mainSelector: string
): HeadingAnalysis {
  const counts: HeadingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  const levels: number[] = [];
  $(mainSelector)
    .find("h1, h2, h3, h4, h5, h6")
    .each((_, el) => {
      const tag = (el as { tagName?: string; name?: string }).tagName
        ?? (el as { tagName?: string; name?: string }).name;
      if (!tag) return;
      const level = parseInt(String(tag).charAt(1), 10);
      if (level >= 1 && level <= 6) {
        counts[`h${level}` as keyof HeadingCounts]++;
        levels.push(level);
      }
    });
  let hierarchyValid = true;
  let prev = 0;
  for (const lvl of levels) {
    if (prev > 0 && lvl > prev + 1) {
      hierarchyValid = false;
      break;
    }
    prev = lvl;
  }
  return { counts, total: levels.length, hierarchyValid };
}

interface LinkStats {
  internal: number;
  external: number;
  total: number;
  densityPer1000Words: number;
}

function analyzeLinks(
  $: CheerioAPI,
  mainSelector: string,
  sourceUrl: string,
  wordCount: number
): LinkStats {
  let internal = 0;
  let external = 0;
  let sourceHost = "";
  try {
    sourceHost = new URL(sourceUrl).hostname;
  } catch {
    /* ignore */
  }
  $(mainSelector)
    .find("a[href]")
    .each((_, el) => {
      const href = $(el).attr("href") || "";
      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:")
      )
        return;
      try {
        const u = new URL(href, sourceUrl);
        if (u.hostname === sourceHost) internal++;
        else external++;
      } catch {
        internal++;
      }
    });
  const total = internal + external;
  const densityPer1000Words =
    wordCount > 0 ? Math.round((total / wordCount) * 10000) / 10 : 0;
  return { internal, external, total, densityPer1000Words };
}

interface MediaStats {
  images: number;
  imagesWithAlt: number;
  videos: number;
  altCoverage: number;
}

function analyzeMedia($: CheerioAPI, mainSelector: string): MediaStats {
  const images = $(mainSelector).find("img");
  const imageCount = images.length;
  let imagesWithAlt = 0;
  images.each((_, el) => {
    const alt = ($(el).attr("alt") || "").trim();
    if (alt) imagesWithAlt++;
  });
  const videos =
    $(mainSelector).find("video").length +
    $(mainSelector).find(
      'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]'
    ).length;
  return {
    images: imageCount,
    imagesWithAlt,
    videos,
    altCoverage:
      imageCount > 0 ? Math.round((imagesWithAlt / imageCount) * 100) : 100,
  };
}

interface EngagementStats {
  hasTOC: boolean;
  hasFAQ: boolean;
  hasCTA: boolean;
}

function analyzeEngagement(
  $: CheerioAPI,
  mainSelector: string,
  hasFaqSchema: boolean
): EngagementStats {
  let hasTOC =
    $(".toc, .table-of-contents, #toc, [role='doc-toc']").length > 0;
  if (!hasTOC) {
    $("nav, ul, ol").each((_, el) => {
      const anchorCount = $(el).find('a[href^="#"]').length;
      if (anchorCount >= 3) {
        hasTOC = true;
        return false;
      }
    });
  }

  let hasFAQ = hasFaqSchema;
  if (!hasFAQ) {
    $(mainSelector)
      .find("h1, h2, h3")
      .each((_, el) => {
        const text = $(el).text();
        if (FAQ_HEADING_PATTERNS.some((p) => p.test(text))) {
          hasFAQ = true;
          return false;
        }
      });
  }

  let hasCTA = false;
  $(mainSelector)
    .find("a, button")
    .each((_, el) => {
      const className = $(el).attr("class") || "";
      if (CTA_CLASS_PATTERN.test(className)) {
        hasCTA = true;
        return false;
      }
    });

  return { hasTOC, hasFAQ, hasCTA };
}

// -------- scoring --------

interface CategoryScore {
  score: number;
  max: number;
}

function scoreWordCount(wordCount: number): {
  score: CategoryScore;
  flag?: "thin-content" | "very-long";
} {
  if (wordCount < 300)
    return { score: { score: 0, max: 25 }, flag: "thin-content" };
  if (wordCount < 600) return { score: { score: 10, max: 25 } };
  if (wordCount < 1200) return { score: { score: 20, max: 25 } };
  if (wordCount <= 2500) return { score: { score: 25, max: 25 } };
  return { score: { score: 25, max: 25 }, flag: "very-long" };
}

function scoreReadability(r: ReadabilityResult): CategoryScore {
  if (r.level === "easy") return { score: 20, max: 20 };
  if (r.level === "moderate") return { score: 12, max: 20 };
  return { score: 5, max: 20 };
}

function scoreTextToHtml(ratio: number): CategoryScore {
  if (ratio > 25) return { score: 15, max: 15 };
  if (ratio >= 15) return { score: 10, max: 15 };
  if (ratio >= 10) return { score: 5, max: 15 };
  return { score: 0, max: 15 };
}

function scoreHeadingsCategory(
  h: HeadingAnalysis,
  wordCount: number
): { score: CategoryScore; flags: string[] } {
  let score = 15;
  const flags: string[] = [];
  if (h.counts.h1 === 0) {
    score -= 5;
    flags.push("missing-h1");
  } else if (h.counts.h1 > 1) {
    score -= 3;
    flags.push("multiple-h1");
  }
  if (!h.hierarchyValid) {
    score -= 3;
    flags.push("broken-hierarchy");
  }
  if (wordCount > 300) {
    const ratio = h.total > 0 ? wordCount / h.total : Infinity;
    if (ratio > 400) {
      score -= 4;
      flags.push("insufficient-headings");
    }
  }
  return { score: { score: Math.max(0, score), max: 15 }, flags };
}

function scoreLinkCategory(
  total: number,
  wordCount: number
): { score: CategoryScore; flag?: string } {
  if (wordCount === 0) return { score: { score: 0, max: 10 } };
  const density = (total / wordCount) * 1000;
  if (density >= 2 && density <= 10) return { score: { score: 10, max: 10 } };
  if (density >= 1 && density < 2)
    return { score: { score: 6, max: 10 }, flag: "few-links" };
  if (density > 10 && density <= 20)
    return { score: { score: 6, max: 10 }, flag: "many-links" };
  if (density < 1)
    return { score: { score: 3, max: 10 }, flag: "too-few-links" };
  return { score: { score: 2, max: 10 }, flag: "over-optimized-links" };
}

function scoreMediaCategory(
  m: MediaStats,
  wordCount: number
): { score: CategoryScore; flags: string[] } {
  let score = 0;
  const flags: string[] = [];
  const hasAny = m.images > 0 || m.videos > 0;
  if (hasAny) score += 3;
  else flags.push("no-media");
  if (m.images > 0) {
    score += Math.round((m.imagesWithAlt / m.images) * 4);
    if (m.imagesWithAlt < m.images) flags.push("missing-alt");
  } else {
    score += 2;
  }
  if (m.images > 0 && wordCount > 0) {
    const per1000 = (m.images / wordCount) * 1000;
    if (per1000 >= 0.5 && per1000 <= 6) score += 3;
    else score += 1;
  }
  return { score: { score: Math.min(10, score), max: 10 }, flags };
}

function scoreEngagementCategory(e: EngagementStats): CategoryScore {
  let score = 0;
  if (e.hasTOC) score += 2;
  if (e.hasFAQ) score += 2;
  if (e.hasCTA) score += 1;
  return { score, max: 5 };
}

// -------- fetch --------

type FetchResult =
  | { ok: true; status: number; html: string; finalUrl: string }
  | { ok: false; status: number; error: string };

async function fetchPageHtml(
  url: string,
  timeout: number
): Promise<FetchResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT },
    });
    clearTimeout(timeoutId);
    const html = await response.text();
    return {
      ok: true,
      status: response.status,
      html,
      finalUrl: response.url || url,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: isAbort
        ? `Request timed out after ${timeout}ms`
        : err instanceof Error
          ? err.message
          : "unknown fetch error",
    };
  }
}

// -------- main handler --------

interface ContentIssue {
  severity: "high" | "medium" | "low" | "info";
  category: string;
  message: string;
}

export async function auditContentQuality({
  url,
  locale,
  timeout,
}: {
  url: string;
  locale: string;
  timeout: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  const fetchResult = await fetchPageHtml(url, timeout);
  if (!fetchResult.ok) {
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Impossible de récupérer ${url}: ${fetchResult.error}`,
      issues: [createIssue("error", "fetch-error", fetchResult.error)],
      recommendations: [`[fetch-error] ${fetchResult.error}`],
      meta: createMeta(startTime, "fetch", false, true),
      data: { error: fetchResult.error },
    };
  }

  const { html, status, finalUrl } = fetchResult;
  const $ = cheerio.load(html);

  // Detect locale
  let effectiveLocale: Locale = "en";
  if (locale === "auto") {
    const htmlLang = ($("html").attr("lang") || "")
      .toLowerCase()
      .split("-")[0];
    if ((SUPPORTED_LOCALES as readonly string[]).includes(htmlLang)) {
      effectiveLocale = htmlLang as Locale;
    }
  } else if ((SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    effectiveLocale = locale as Locale;
  }

  // Detect FAQPage schema before removing scripts
  let hasFaqSchema = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (/"@type"\s*:\s*"FAQPage"/i.test($(el).text())) {
      hasFaqSchema = true;
      return false;
    }
  });

  // Strip excluded selectors for content analysis
  $(EXCLUDED_SELECTORS).remove();

  // Find main content container
  let mainSelector = "main";
  let fallbackUsed = false;
  if ($("main").length === 0) {
    if ($('[role="main"]').length > 0) mainSelector = '[role="main"]';
    else if ($("article").length > 0) mainSelector = "article";
    else mainSelector = "body";
  }

  let mainText = cleanText($(mainSelector).first().text());
  let wordCount = countWords(mainText);
  if (wordCount < 50 && mainSelector !== "body") {
    mainSelector = "body";
    mainText = cleanText($(mainSelector).first().text());
    wordCount = countWords(mainText);
    fallbackUsed = true;
  }

  // Paragraph stats
  const paragraphs = $(mainSelector).find("p");
  const paragraphCount = paragraphs.length;
  let avgWordsPerParagraph = 0;
  if (paragraphCount > 0) {
    let totalPWords = 0;
    paragraphs.each((_, el) => {
      totalPWords += countWords(cleanText($(el).text()));
    });
    avgWordsPerParagraph = Math.round(totalPWords / paragraphCount);
  }

  const readability = computeReadability(mainText, effectiveLocale);

  const htmlBytes = Buffer.byteLength(html, "utf-8");
  const textBytes = Buffer.byteLength(mainText, "utf-8");
  const textToHtmlRatio =
    htmlBytes > 0 ? Math.round((textBytes / htmlBytes) * 10000) / 100 : 0;

  const headings = analyzeHeadings($, mainSelector);
  const links = analyzeLinks($, mainSelector, finalUrl, wordCount);
  const media = analyzeMedia($, mainSelector);
  const engagement = analyzeEngagement($, mainSelector, hasFaqSchema);

  const wcResult = scoreWordCount(wordCount);
  const readResult = scoreReadability(readability);
  const textResult = scoreTextToHtml(textToHtmlRatio);
  const headingResult = scoreHeadingsCategory(headings, wordCount);
  const linkResult = scoreLinkCategory(links.total, wordCount);
  const mediaResult = scoreMediaCategory(media, wordCount);
  const engagementResult = scoreEngagementCategory(engagement);

  const categoryScores = {
    wordCountAndStructure: wcResult.score,
    readability: readResult,
    contentUniqueness: textResult,
    headingStructure: headingResult.score,
    linkDensity: linkResult.score,
    mediaRichness: mediaResult.score,
    engagementSignals: engagementResult,
  };

  const totalScore = Object.values(categoryScores).reduce(
    (sum, c) => sum + c.score,
    0
  );
  const totalMax = Object.values(categoryScores).reduce(
    (sum, c) => sum + c.max,
    0
  );
  const finalScore = Math.round((totalScore / totalMax) * 100);

  let grade: "A" | "B" | "C" | "D" | "F";
  if (finalScore >= 90) grade = "A";
  else if (finalScore >= 70) grade = "B";
  else if (finalScore >= 50) grade = "C";
  else if (finalScore >= 30) grade = "D";
  else grade = "F";

  // Build issues
  const contentIssues: ContentIssue[] = [];
  const stdIssues = [];

  if (fallbackUsed) {
    contentIssues.push({
      severity: "low",
      category: "extraction",
      message:
        "Unable to isolate main content via semantic markup — used full body as fallback",
    });
    stdIssues.push(
      createIssue(
        "info",
        "extraction-fallback",
        "Main content extracted from full body (no <main>, [role=main], or <article> found)"
      )
    );
  }

  if (wcResult.flag === "thin-content") {
    contentIssues.push({
      severity: "high",
      category: "wordCount",
      message: `Thin content: only ${wordCount} words (recommended minimum: 300)`,
    });
    stdIssues.push(
      createIssue(
        "error",
        "thin-content",
        `Only ${wordCount} words — risk of being treated as thin content by search engines`
      )
    );
  } else if (wcResult.flag === "very-long") {
    contentIssues.push({
      severity: "info",
      category: "wordCount",
      message: `Very long article (${wordCount} words) — consider splitting or adding a table of contents`,
    });
  }

  if (readability.level !== "easy") {
    const target =
      effectiveLocale === "en"
        ? "15-20"
        : effectiveLocale === "fr"
          ? "15-17"
          : "15-18";
    contentIssues.push({
      severity: readability.level === "difficult" ? "medium" : "low",
      category: "readability",
      message: `Readability is ${readability.level} (score ${readability.score}). Average sentence length ${readability.avgSentenceLength} — aim for ${target} words per sentence.`,
    });
    stdIssues.push(
      createIssue(
        readability.level === "difficult" ? "warning" : "info",
        "readability",
        `Readability ${readability.level} (${readability.score}/100)`
      )
    );
  }

  if (textToHtmlRatio < 10) {
    contentIssues.push({
      severity: "high",
      category: "contentUniqueness",
      message: `Low text-to-HTML ratio (${textToHtmlRatio}%) — page is boilerplate-heavy`,
    });
    stdIssues.push(
      createIssue(
        "error",
        "boilerplate-heavy",
        `Text-to-HTML ratio ${textToHtmlRatio}% is below 10%`
      )
    );
  } else if (textToHtmlRatio < 15) {
    contentIssues.push({
      severity: "medium",
      category: "contentUniqueness",
      message: `Text-to-HTML ratio is low (${textToHtmlRatio}%) — reduce boilerplate markup`,
    });
  }

  for (const flag of headingResult.flags) {
    if (flag === "missing-h1") {
      contentIssues.push({
        severity: "high",
        category: "headings",
        message: "Page has no H1 heading",
      });
      stdIssues.push(createIssue("error", "missing-h1", "Missing H1 heading"));
    } else if (flag === "multiple-h1") {
      contentIssues.push({
        severity: "medium",
        category: "headings",
        message: `Page has ${headings.counts.h1} H1 headings — use only one`,
      });
      stdIssues.push(
        createIssue(
          "warning",
          "multiple-h1",
          `${headings.counts.h1} H1 headings found`
        )
      );
    } else if (flag === "broken-hierarchy") {
      contentIssues.push({
        severity: "medium",
        category: "headings",
        message: "Heading hierarchy skips levels (e.g., H1 → H3 without H2)",
      });
      stdIssues.push(
        createIssue(
          "warning",
          "broken-hierarchy",
          "Heading hierarchy skips levels"
        )
      );
    } else if (flag === "insufficient-headings") {
      contentIssues.push({
        severity: "low",
        category: "headings",
        message: `Not enough headings: ${headings.total} for ${wordCount} words`,
      });
    }
  }

  if (linkResult.flag === "too-few-links") {
    contentIssues.push({
      severity: "low",
      category: "links",
      message: `Very few links (${links.densityPer1000Words}/1000 words) — consider adding internal links`,
    });
  } else if (linkResult.flag === "over-optimized-links") {
    contentIssues.push({
      severity: "medium",
      category: "links",
      message: `Too many links (${links.densityPer1000Words}/1000 words) — may look over-optimized`,
    });
  }

  if (mediaResult.flags.includes("no-media") && wordCount > 500) {
    contentIssues.push({
      severity: "low",
      category: "media",
      message: "Page has no images or videos — consider adding visual content",
    });
  }
  if (mediaResult.flags.includes("missing-alt")) {
    contentIssues.push({
      severity: "low",
      category: "media",
      message: `${media.images - media.imagesWithAlt} image(s) missing alt text (${media.altCoverage}% alt coverage)`,
    });
    stdIssues.push(
      createIssue(
        "warning",
        "missing-alt",
        `${media.altCoverage}% image alt coverage`
      )
    );
  }

  if (!engagement.hasTOC && wordCount > 1200) {
    contentIssues.push({
      severity: "info",
      category: "engagement",
      message: `Consider adding a table of contents for long-form content (${wordCount} words)`,
    });
  }
  if (!engagement.hasCTA) {
    contentIssues.push({
      severity: "info",
      category: "engagement",
      message: "No clear call-to-action detected",
    });
  }

  const contentRecommendations = contentIssues
    .filter((i) => i.severity === "high" || i.severity === "medium")
    .map((i) => i.message);

  return {
    url,
    finalUrl,
    status,
    score: finalScore,
    summary: `Audit de qualité du contenu de ${url}: score ${finalScore}/100 (grade ${grade}, ${wordCount} mots)`,
    issues: stdIssues,
    recommendations: generateRecommendations(stdIssues),
    meta: createMeta(startTime, "fetch", false, fallbackUsed),
    data: {
      grade,
      locale: effectiveLocale,
      metrics: {
        wordCount,
        paragraphCount,
        avgWordsPerParagraph,
        avgSentenceLength: readability.avgSentenceLength,
        avgWordLength: readability.avgWordLength,
        readabilityScore: readability.score,
        readabilityLevel: readability.level,
        textToHtmlRatio,
        headings: {
          ...headings.counts,
          total: headings.total,
          hierarchyValid: headings.hierarchyValid,
        },
        links,
        media,
        engagement,
      },
      categoryScores,
      contentIssues,
      contentRecommendations,
      fallbackUsed,
    },
  };
}
