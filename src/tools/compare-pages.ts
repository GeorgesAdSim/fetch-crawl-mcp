import { z } from "zod";
import { fetchUrl, withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractLinks,
  extractImages,
  extractTextContent,
  extractJsonLd,
} from "../utils/html-parser.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const comparePagesSchema = {
  urlA: z.string().url().describe("First URL to compare"),
  urlB: z.string().url().describe("Second URL to compare"),
  includeScreenshot: z
    .boolean()
    .default(false)
    .describe("If true, capture a JPEG screenshot (quality 60) of each page"),
};

interface PageSummary {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  titleLength: number;
  description: string;
  descriptionLength: number;
  lang: string | null;
  canonical: string | null;
  h1: string[];
  headingsCount: number;
  wordCount: number;
  internalLinks: number;
  externalLinks: number;
  imagesTotal: number;
  imagesWithoutAlt: number;
  ogTagsCount: number;
  twitterCardPresent: boolean;
  jsonLdCount: number;
  jsonLdTypes: string[];
}

interface ComparisonRow {
  criterion: string;
  urlA: string | number;
  urlB: string | number;
  winner: "A" | "B" | "equal";
  note: string;
}

function extractPageSummary(html: string, baseUrl: string, fetchedUrl: string, finalUrl: string, status: number): PageSummary {
  const metadata = extractMetadata(html, baseUrl);
  const headings = extractHeadings(html);
  const links = extractLinks(html, baseUrl);
  const images = extractImages(html, baseUrl);
  const textContent = extractTextContent(html);
  const jsonLd = extractJsonLd(html);

  const h1s = headings.filter((h) => h.level === 1);
  const words = textContent.split(/\s+/).filter(Boolean);

  const jsonLdTypes: string[] = [];
  for (const item of jsonLd) {
    if (item && typeof item === "object" && "@type" in (item as Record<string, unknown>)) {
      jsonLdTypes.push(String((item as Record<string, unknown>)["@type"]));
    }
  }

  return {
    url: fetchedUrl,
    finalUrl,
    status,
    title: metadata.title,
    titleLength: metadata.title.length,
    description: metadata.description,
    descriptionLength: metadata.description.length,
    lang: metadata.lang,
    canonical: metadata.canonical,
    h1: h1s.map((h) => h.text),
    headingsCount: headings.length,
    wordCount: words.length,
    internalLinks: links.filter((l) => l.isInternal).length,
    externalLinks: links.filter((l) => !l.isInternal).length,
    imagesTotal: images.length,
    imagesWithoutAlt: images.filter((i) => !i.alt).length,
    ogTagsCount: Object.keys(metadata.ogTags).length,
    twitterCardPresent: Object.keys(metadata.twitterTags).length > 0,
    jsonLdCount: jsonLd.length,
    jsonLdTypes,
  };
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function compare(a: number, b: number): "A" | "B" | "equal" {
  if (a > b) return "A";
  if (b > a) return "B";
  return "equal";
}

function buildComparison(a: PageSummary, b: PageSummary): ComparisonRow[] {
  const rows: ComparisonRow[] = [];

  // Title
  const aGoodTitle = inRange(a.titleLength, 30, 60);
  const bGoodTitle = inRange(b.titleLength, 30, 60);
  rows.push({
    criterion: "title",
    urlA: `${a.titleLength} chars`,
    urlB: `${b.titleLength} chars`,
    winner: aGoodTitle === bGoodTitle ? "equal" : aGoodTitle ? "A" : "B",
    note: "Optimal: 30-60 characters",
  });

  // Meta description
  const aGoodDesc = inRange(a.descriptionLength, 120, 160);
  const bGoodDesc = inRange(b.descriptionLength, 120, 160);
  rows.push({
    criterion: "meta_description",
    urlA: `${a.descriptionLength} chars`,
    urlB: `${b.descriptionLength} chars`,
    winner: aGoodDesc === bGoodDesc ? "equal" : aGoodDesc ? "A" : "B",
    note: "Optimal: 120-160 characters",
  });

  // H1
  const aHasH1 = a.h1.length > 0;
  const bHasH1 = b.h1.length > 0;
  rows.push({
    criterion: "h1",
    urlA: a.h1.length > 0 ? a.h1[0] : "(none)",
    urlB: b.h1.length > 0 ? b.h1[0] : "(none)",
    winner: aHasH1 === bHasH1 ? "equal" : aHasH1 ? "A" : "B",
    note: "Every page should have exactly one H1",
  });

  // Heading structure
  rows.push({
    criterion: "heading_structure",
    urlA: a.headingsCount,
    urlB: b.headingsCount,
    winner: compare(a.headingsCount, b.headingsCount),
    note: "More headings = better content structure",
  });

  // Word count
  const ratio = a.wordCount > 0 && b.wordCount > 0
    ? Math.max(a.wordCount, b.wordCount) / Math.min(a.wordCount, b.wordCount)
    : 1;
  let wcWinner = compare(a.wordCount, b.wordCount);
  let wcNote = "More content generally helps SEO";
  if (ratio > 5) {
    wcNote = "One page has 5x+ more content — may be bloated";
  }
  rows.push({
    criterion: "word_count",
    urlA: a.wordCount,
    urlB: b.wordCount,
    winner: wcWinner,
    note: wcNote,
  });

  // Internal links
  rows.push({
    criterion: "internal_links",
    urlA: a.internalLinks,
    urlB: b.internalLinks,
    winner: compare(a.internalLinks, b.internalLinks),
    note: "More internal links = better internal linking",
  });

  // External links
  rows.push({
    criterion: "external_links",
    urlA: a.externalLinks,
    urlB: b.externalLinks,
    winner: compare(a.externalLinks, b.externalLinks),
    note: "Some external links are good for credibility",
  });

  // Images alt ratio
  const aAltRatio = a.imagesTotal > 0 ? (a.imagesTotal - a.imagesWithoutAlt) / a.imagesTotal : 1;
  const bAltRatio = b.imagesTotal > 0 ? (b.imagesTotal - b.imagesWithoutAlt) / b.imagesTotal : 1;
  rows.push({
    criterion: "images_alt",
    urlA: `${Math.round(aAltRatio * 100)}% (${a.imagesTotal} imgs)`,
    urlB: `${Math.round(bAltRatio * 100)}% (${b.imagesTotal} imgs)`,
    winner: aAltRatio === bAltRatio ? "equal" : aAltRatio > bAltRatio ? "A" : "B",
    note: "Higher alt text coverage = better accessibility",
  });

  // Open Graph
  rows.push({
    criterion: "open_graph",
    urlA: a.ogTagsCount,
    urlB: b.ogTagsCount,
    winner: compare(a.ogTagsCount, b.ogTagsCount),
    note: "More OG tags = better social sharing",
  });

  // Twitter Card
  rows.push({
    criterion: "twitter_card",
    urlA: a.twitterCardPresent ? "yes" : "no",
    urlB: b.twitterCardPresent ? "yes" : "no",
    winner: a.twitterCardPresent === b.twitterCardPresent ? "equal" : a.twitterCardPresent ? "A" : "B",
    note: "Twitter Card meta tags improve link previews",
  });

  // JSON-LD
  rows.push({
    criterion: "json_ld",
    urlA: a.jsonLdCount,
    urlB: b.jsonLdCount,
    winner: compare(a.jsonLdCount, b.jsonLdCount),
    note: "Structured data helps search engines understand content",
  });

  // Canonical
  const aHasCan = a.canonical !== null;
  const bHasCan = b.canonical !== null;
  rows.push({
    criterion: "canonical",
    urlA: aHasCan ? "present" : "missing",
    urlB: bHasCan ? "present" : "missing",
    winner: aHasCan === bHasCan ? "equal" : aHasCan ? "A" : "B",
    note: "Canonical tag prevents duplicate content issues",
  });

  return rows;
}

function calculatePageScore(p: PageSummary): number {
  let score = 0;

  // Title: 0-15
  if (inRange(p.titleLength, 30, 60)) score += 15;
  else if (p.titleLength > 0) score += 8;

  // Description: 0-10
  if (inRange(p.descriptionLength, 120, 160)) score += 10;
  else if (p.descriptionLength > 0) score += 5;

  // H1: 0-10
  if (p.h1.length === 1) score += 10;
  else if (p.h1.length > 1) score += 5;

  // Headings: 0-10
  if (p.headingsCount >= 5) score += 10;
  else if (p.headingsCount >= 2) score += 5;

  // Word count: 0-10
  if (p.wordCount >= 300) score += 10;
  else if (p.wordCount >= 100) score += 5;

  // Internal links: 0-10
  if (p.internalLinks >= 5) score += 10;
  else if (p.internalLinks >= 1) score += 5;

  // External links: 0-5
  if (p.externalLinks >= 1) score += 5;

  // Images alt: 0-10
  const altRatio = p.imagesTotal > 0 ? (p.imagesTotal - p.imagesWithoutAlt) / p.imagesTotal : 1;
  if (altRatio >= 0.9) score += 10;
  else if (altRatio >= 0.5) score += 5;

  // OG: 0-5
  if (p.ogTagsCount >= 3) score += 5;
  else if (p.ogTagsCount >= 1) score += 2;

  // Twitter: 0-5
  if (p.twitterCardPresent) score += 5;

  // JSON-LD: 0-5
  if (p.jsonLdCount >= 1) score += 5;

  // Canonical: 0-5
  if (p.canonical !== null) score += 5;

  return score;
}

async function takeScreenshots(urlA: string, urlB: string): Promise<{ screenshotA: string; screenshotB: string }> {
  return withPuppeteerTimeout(async () => {
    const puppeteer = await import("puppeteer");

    let browser;
    try {
      browser = await puppeteer.default.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });

      const [pageA, pageB] = await Promise.all([browser.newPage(), browser.newPage()]);

      await Promise.all([
        pageA.setViewport({ width: 1280, height: 800 }),
        pageB.setViewport({ width: 1280, height: 800 }),
      ]);

      await Promise.all([
        pageA.goto(urlA, { waitUntil: "networkidle2", timeout: 30000 }),
        pageB.goto(urlB, { waitUntil: "networkidle2", timeout: 30000 }),
      ]);

      const [bufA, bufB] = await Promise.all([
        pageA.screenshot({ type: "jpeg", quality: 60 }),
        pageB.screenshot({ type: "jpeg", quality: 60 }),
      ]);

      return {
        screenshotA: Buffer.from(bufA).toString("base64"),
        screenshotB: Buffer.from(bufB).toString("base64"),
      };
    } finally {
      if (browser) await browser.close();
    }
  }, 60000);
}

export async function comparePages({
  urlA,
  urlB,
  includeScreenshot,
}: {
  urlA: string;
  urlB: string;
  includeScreenshot: boolean;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  // Fetch both pages in parallel
  const [resultA, resultB] = await Promise.all([
    fetchUrl(urlA),
    fetchUrl(urlB),
  ]);

  const pageA = extractPageSummary(resultA.body, resultA.finalUrl, urlA, resultA.finalUrl, resultA.status);
  const pageB = extractPageSummary(resultB.body, resultB.finalUrl, urlB, resultB.finalUrl, resultB.status);

  const comparison = buildComparison(pageA, pageB);
  const scoreA = calculatePageScore(pageA);
  const scoreB = calculatePageScore(pageB);

  const winnersA = comparison.filter((r) => r.winner === "A").length;
  const winnersB = comparison.filter((r) => r.winner === "B").length;

  // Issues
  const issues = [];

  if (scoreA > scoreB + 20) {
    issues.push(createIssue("warning", "score-gap", `Page A scores significantly higher than B (${scoreA} vs ${scoreB})`, `Δ${scoreA - scoreB}`));
  } else if (scoreB > scoreA + 20) {
    issues.push(createIssue("warning", "score-gap", `Page B scores significantly higher than A (${scoreB} vs ${scoreA})`, `Δ${scoreB - scoreA}`));
  }

  for (const row of comparison) {
    if (row.winner !== "equal") {
      issues.push(createIssue("info", row.criterion, `${row.criterion}: ${row.winner} wins — ${row.note}`, `A=${row.urlA}, B=${row.urlB}`));
    }
  }

  // Screenshots
  let screenshotA: string | undefined;
  let screenshotB: string | undefined;

  if (includeScreenshot) {
    try {
      const shots = await takeScreenshots(urlA, urlB);
      screenshotA = shots.screenshotA;
      screenshotB = shots.screenshotB;
    } catch {
      issues.push(createIssue("warning", "screenshot", "Failed to capture screenshots"));
    }
  }

  const data: Record<string, unknown> = {
    pageA,
    pageB,
    comparison,
    scoreA,
    scoreB,
  };

  if (screenshotA) data.screenshotA = screenshotA;
  if (screenshotB) data.screenshotB = screenshotB;

  return {
    url: urlA,
    finalUrl: urlB,
    status: resultA.status,
    score: Math.abs(scoreA - scoreB),
    summary: `Comparaison ${urlA} vs ${urlB}: A=${scoreA}/100, B=${scoreB}/100, ${winnersA} critères pour A, ${winnersB} pour B`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data,
  };
}
