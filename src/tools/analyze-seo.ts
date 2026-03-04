import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractImages,
  extractJsonLd,
} from "../utils/html-parser.js";

export const auditOnpageSchema = {
  url: z
    .string()
    .url()
    .describe("The URL to audit for on-page technical issues"),
};

interface OnpageIssue {
  severity: "error" | "warning" | "info";
  element: string;
  message: string;
}

export async function auditOnpage({ url }: { url: string }) {
  const result = await fetchUrl(url);
  const baseUrl = result.finalUrl;

  const metadata = extractMetadata(result.body, baseUrl);
  const headings = extractHeadings(result.body);
  const images = extractImages(result.body, baseUrl);
  const jsonLd = extractJsonLd(result.body);

  const issues: OnpageIssue[] = [];

  // --- Title tag ---
  if (!metadata.title) {
    issues.push({
      severity: "error",
      element: "title",
      message: "Missing title tag",
    });
  } else if (metadata.title.length < 10) {
    issues.push({
      severity: "warning",
      element: "title",
      message: `Too short (${metadata.title.length} chars, recommended: 30-60)`,
    });
  } else if (metadata.title.length > 60) {
    issues.push({
      severity: "warning",
      element: "title",
      message: `Too long (${metadata.title.length} chars, recommended: 30-60)`,
    });
  }

  // --- Meta description ---
  if (!metadata.description) {
    issues.push({
      severity: "error",
      element: "meta-description",
      message: "Missing meta description",
    });
  } else if (metadata.description.length < 50) {
    issues.push({
      severity: "warning",
      element: "meta-description",
      message: `Too short (${metadata.description.length} chars, recommended: 120-160)`,
    });
  } else if (metadata.description.length > 160) {
    issues.push({
      severity: "warning",
      element: "meta-description",
      message: `Too long (${metadata.description.length} chars, recommended: 120-160)`,
    });
  }

  // --- Canonical ---
  if (!metadata.canonical) {
    issues.push({
      severity: "info",
      element: "canonical",
      message: "No canonical URL specified",
    });
  }

  // --- Language ---
  if (!metadata.lang) {
    issues.push({
      severity: "warning",
      element: "html-lang",
      message: "Missing lang attribute on <html> tag",
    });
  }

  // --- HTTPS ---
  if (!url.startsWith("https://")) {
    issues.push({
      severity: "warning",
      element: "protocol",
      message: "Page is not served over HTTPS",
    });
  }

  // --- H1 ---
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    issues.push({
      severity: "error",
      element: "h1",
      message: "Missing H1 heading",
    });
  } else if (h1s.length > 1) {
    issues.push({
      severity: "warning",
      element: "h1",
      message: `Multiple H1 headings found (${h1s.length})`,
    });
  }

  // --- Heading hierarchy ---
  const headingLevels = headings.map((h) => h.level);
  for (let i = 1; i < headingLevels.length; i++) {
    if (headingLevels[i] > headingLevels[i - 1] + 1) {
      issues.push({
        severity: "warning",
        element: "heading-hierarchy",
        message: `Skip detected: H${headingLevels[i - 1]} -> H${headingLevels[i]}`,
      });
      break;
    }
  }

  // --- Images without alt ---
  const imagesWithoutAlt = images.filter((img) => !img.alt);
  if (imagesWithoutAlt.length > 0) {
    issues.push({
      severity: "warning",
      element: "img-alt",
      message: `${imagesWithoutAlt.length} image(s) missing alt attribute`,
    });
  }

  // --- Open Graph ---
  if (Object.keys(metadata.ogTags).length === 0) {
    issues.push({
      severity: "info",
      element: "open-graph",
      message: "No Open Graph tags found",
    });
  }

  // --- Twitter Card ---
  if (Object.keys(metadata.twitterTags).length === 0) {
    issues.push({
      severity: "info",
      element: "twitter-card",
      message: "No Twitter Card tags found",
    });
  }

  return {
    url: result.url,
    finalUrl: baseUrl,
    status: result.status,
    title: {
      content: metadata.title || null,
      length: metadata.title.length,
    },
    metaDescription: {
      content: metadata.description || null,
      length: metadata.description.length,
    },
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
    structuredData: {
      jsonLdCount: jsonLd.length,
      jsonLd: jsonLd.slice(0, 5),
    },
    issues,
    issuesSummary: {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
      info: issues.filter((i) => i.severity === "info").length,
    },
  };
}
