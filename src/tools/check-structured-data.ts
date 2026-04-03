import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import * as cheerio from "cheerio";

export const checkStructuredDataSchema = {
  url: z.string().url().describe("The URL to extract structured data from"),
};

type Severity = "error" | "warning" | "info";

interface Issue {
  severity: Severity;
  message: string;
}

interface JsonLdResult {
  raw: unknown;
  type: string | null;
  valid: boolean;
  errors: string[];
}

interface MicrodataItem {
  type: string;
  properties: Record<string, string>;
}

function validateJsonLd(data: unknown): JsonLdResult {
  if (!data || typeof data !== "object") {
    return { raw: data, type: null, valid: false, errors: ["Not a valid JSON-LD object"] };
  }

  const obj = data as Record<string, unknown>;
  const type = (typeof obj["@type"] === "string" ? obj["@type"] : null);
  const errors: string[] = [];

  if (!type) {
    errors.push("Missing @type property");
    return { raw: data, type: null, valid: false, errors };
  }

  const requireFields = (fields: string[], label: string) => {
    for (const field of fields) {
      if (obj[field] === undefined && obj[field] !== null) {
        errors.push(`${label}: missing "${field}"`);
      }
    }
  };

  const requireNested = (
    parent: string,
    fields: string[],
    label: string
  ) => {
    const nested = obj[parent];
    if (!nested || typeof nested !== "object") return;
    const n = nested as Record<string, unknown>;
    for (const field of fields) {
      if (n[field] === undefined) {
        errors.push(`${label}: missing "${parent}.${field}"`);
      }
    }
  };

  switch (type) {
    case "Product":
      requireFields(["name", "image", "description", "offers"], "Product");
      if (obj["offers"] && typeof obj["offers"] === "object") {
        requireNested("offers", ["price", "priceCurrency"], "Product");
      } else if (!obj["offers"]) {
        // already reported above
      } else {
        errors.push('Product: "offers" should be an object');
      }
      break;

    case "Organization":
    case "LocalBusiness":
      requireFields(["name", "url", "logo"], type);
      break;

    case "BreadcrumbList":
      requireFields(["itemListElement"], "BreadcrumbList");
      break;

    case "Article":
    case "NewsArticle":
    case "BlogPosting":
      requireFields(["headline", "datePublished", "author"], type);
      break;
  }

  return {
    raw: data,
    type,
    valid: errors.length === 0,
    errors,
  };
}

export async function checkStructuredData({ url }: { url: string }) {
  const fetchResult = await fetchUrl(url);
  const $ = cheerio.load(fetchResult.body);

  // JSON-LD
  const jsonLdResults: JsonLdResult[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const text = $(el).html();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      // Handle @graph arrays
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          jsonLdResults.push(validateJsonLd(item));
        }
      } else if (parsed["@graph"] && Array.isArray(parsed["@graph"])) {
        for (const item of parsed["@graph"]) {
          jsonLdResults.push(validateJsonLd(item));
        }
      } else {
        jsonLdResults.push(validateJsonLd(parsed));
      }
    } catch {
      jsonLdResults.push({
        raw: text,
        type: null,
        valid: false,
        errors: ["Invalid JSON in JSON-LD block"],
      });
    }
  });

  // Microdata
  const microdata: MicrodataItem[] = [];
  $("[itemscope]").each((_i, el) => {
    const itemtype = $(el).attr("itemtype") || "";
    const properties: Record<string, string> = {};
    $(el)
      .find("[itemprop]")
      .each((_j, prop) => {
        const name = $(prop).attr("itemprop") || "";
        const value =
          $(prop).attr("content") ||
          $(prop).attr("href") ||
          $(prop).attr("src") ||
          $(prop).text().trim();
        if (name) {
          properties[name] = value;
        }
      });
    microdata.push({ type: itemtype, properties });
  });

  // Open Graph
  const openGraph: Record<string, string> = {};
  $("meta[property^='og:']").each((_i, el) => {
    const property = $(el).attr("property") || "";
    const content = $(el).attr("content") || "";
    openGraph[property] = content;
  });

  // Twitter Card
  const twitterCard: Record<string, string> = {};
  $("meta[name^='twitter:']").each((_i, el) => {
    const name = $(el).attr("name") || "";
    const content = $(el).attr("content") || "";
    twitterCard[name] = content;
  });

  // Build issues
  const issues: Issue[] = [];

  if (jsonLdResults.length === 0) {
    issues.push({
      severity: "warning",
      message: "No JSON-LD structured data found on the page.",
    });
  }

  for (const result of jsonLdResults) {
    if (!result.valid) {
      for (const err of result.errors) {
        issues.push({
          severity: "error",
          message: `JSON-LD${result.type ? ` (${result.type})` : ""}: ${err}`,
        });
      }
    } else {
      issues.push({
        severity: "info",
        message: `JSON-LD "${result.type}" is valid.`,
      });
    }
  }

  if (Object.keys(openGraph).length === 0) {
    issues.push({
      severity: "warning",
      message: "No Open Graph meta tags found.",
    });
  }

  if (Object.keys(twitterCard).length === 0) {
    issues.push({
      severity: "warning",
      message: "No Twitter Card meta tags found.",
    });
  }

  const validCount = jsonLdResults.filter((r) => r.valid).length;
  const invalidCount = jsonLdResults.filter((r) => !r.valid).length;

  return {
    url,
    jsonLd: jsonLdResults,
    microdata,
    openGraph,
    twitterCard,
    issues,
    summary: {
      totalSchemas: jsonLdResults.length,
      validCount,
      invalidCount,
    },
  };
}
