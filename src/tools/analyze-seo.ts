import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractImages,
  extractJsonLd,
} from "../utils/html-parser.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  calculateScore,
  generateRecommendations,
} from "../utils/response.js";

export const auditOnpageSchema = {
  url: z
    .string()
    .url()
    .describe("The URL to audit for on-page technical issues"),
};

export async function auditOnpage({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();
  const result = await fetchUrl(url);
  const baseUrl = result.finalUrl;

  const metadata = extractMetadata(result.body, baseUrl);
  const headings = extractHeadings(result.body);
  const images = extractImages(result.body, baseUrl);
  const jsonLd = extractJsonLd(result.body);

  const issues = [];

  if (!metadata.title) {
    issues.push(createIssue("error", "title", "Missing title tag"));
  } else if (metadata.title.length < 10) {
    issues.push(createIssue("warning", "title", `Too short (${metadata.title.length} chars, recommended: 30-60)`, metadata.title));
  } else if (metadata.title.length > 60) {
    issues.push(createIssue("warning", "title", `Too long (${metadata.title.length} chars, recommended: 30-60)`, metadata.title));
  }

  if (!metadata.description) {
    issues.push(createIssue("error", "meta-description", "Missing meta description"));
  } else if (metadata.description.length < 50) {
    issues.push(createIssue("warning", "meta-description", `Too short (${metadata.description.length} chars, recommended: 120-160)`, metadata.description));
  } else if (metadata.description.length > 160) {
    issues.push(createIssue("warning", "meta-description", `Too long (${metadata.description.length} chars, recommended: 120-160)`, metadata.description));
  }

  if (!metadata.canonical) {
    issues.push(createIssue("info", "canonical", "No canonical URL specified"));
  }

  if (!metadata.lang) {
    issues.push(createIssue("warning", "html-lang", "Missing lang attribute on <html> tag"));
  }

  if (!url.startsWith("https://")) {
    issues.push(createIssue("warning", "protocol", "Page is not served over HTTPS"));
  }

  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    issues.push(createIssue("error", "h1", "Missing H1 heading"));
  } else if (h1s.length > 1) {
    issues.push(createIssue("warning", "h1", `Multiple H1 headings found (${h1s.length})`, h1s.map((h) => h.text).join(", ")));
  }

  const headingLevels = headings.map((h) => h.level);
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] > headingLevels[i - 1] + 1) {
      issues.push(createIssue("warning", "heading-hierarchy", `Skip detected: H${headingLevels[i - 1]} -> H${headingLevels[i]}`));
      break;
    }
  }

  const imagesWithoutAlt = images.filter((img) => !img.alt);
  if (imagesWithoutAlt.length > 0) {
    issues.push(createIssue("warning", "img-alt", `${imagesWithoutAlt.length} image(s) missing alt attribute`, imagesWithoutAlt.slice(0, 5).map((i) => i.src).join(", ")));
  }

  if (Object.keys(metadata.ogTags).length === 0) {
    issues.push(createIssue("info", "open-graph", "No Open Graph tags found"));
  }

  if (Object.keys(metadata.twitterTags).length === 0) {
    issues.push(createIssue("info", "twitter-card", "No Twitter Card tags found"));
  }

  const score = calculateScore(issues);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;

  return {
    url: result.url,
    finalUrl: baseUrl,
    status: result.status,
    score,
    summary: `Audit on-page de ${baseUrl}: score ${score}/100, ${errors} erreurs, ${warnings} avertissements`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(
      startTime,
      result.fetchedWith,
      result.fetchedWith === "puppeteer",
      result.partial
    ),
    data: {
      title: { content: metadata.title || null, length: metadata.title.length },
      metaDescription: { content: metadata.description || null, length: metadata.description.length },
      canonical: metadata.canonical,
      robots: metadata.robots,
      lang: metadata.lang,
      openGraph: metadata.ogTags,
      twitterCard: metadata.twitterTags,
      headings: {
        h1: h1s.map((h) => h.text),
        h2: headings.filter((h) => h.level === 2).map((h) => h.text),
        h3: headings.filter((h) => h.level === 3).map((h) => h.text),
        total: headings.length,
      },
      images: {
        total: images.length,
        withoutAlt: imagesWithoutAlt.length,
        missingAltUrls: imagesWithoutAlt.slice(0, 10).map((i) => i.src),
      },
      structuredData: { jsonLdCount: jsonLd.length, jsonLd: jsonLd.slice(0, 5) },
    },
  };
}
