import { z } from "zod";
import * as cheerio from "cheerio";
import { fetchUrl } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

const fieldSchemaShape = z.object({
  selector: z.string().describe("CSS selector to match elements"),
  attribute: z
    .string()
    .optional()
    .describe("HTML attribute to extract (src, href, data-*, etc.)"),
  multiple: z
    .boolean()
    .optional()
    .describe("If true, return an array of all matching elements"),
  transform: z
    .enum(["text", "html", "number", "trim", "href"])
    .optional()
    .describe("Transform to apply: text (innerText), html (innerHTML), number (parseFloat), trim (trimmed text), href (href attribute)"),
});

export const extractWithSchemaSchema = {
  url: z.string().url().describe("URL to extract data from"),
  schema: z
    .record(z.string(), fieldSchemaShape)
    .optional()
    .describe("Extraction schema: keys are field names, values define selector/attribute/multiple/transform"),
  fallbackSelectors: z
    .record(z.string(), fieldSchemaShape)
    .optional()
    .describe("Fallback selectors used when primary selector finds nothing"),
  preset: z
    .enum(["ecommerce-product", "article", "local-business", "recipe"])
    .optional()
    .describe("Built-in preset schema. If both preset and schema are provided, schema overrides preset fields"),
};

interface FieldDef {
  selector: string;
  attribute?: string;
  multiple?: boolean;
  transform?: "text" | "html" | "number" | "trim" | "href";
}

type SchemaMap = Record<string, FieldDef>;

const PRESETS: Record<string, SchemaMap> = {
  "ecommerce-product": {
    productName: { selector: "h1", transform: "text" },
    price: { selector: ".price, [itemprop='price'], .product-price .current", transform: "number" },
    oldPrice: { selector: ".old-price, .regular-price, .was-price, del .price", transform: "number" },
    currency: { selector: "[itemprop='priceCurrency']", attribute: "content" },
    images: { selector: ".product-gallery img, .product-images img, [itemprop='image']", attribute: "src", multiple: true },
    description: { selector: "[itemprop='description'], .product-description, .product-detail", transform: "html" },
    sku: { selector: "[itemprop='sku'], .product-sku", transform: "text" },
    brand: { selector: "[itemprop='brand'], .product-brand", transform: "text" },
    availability: { selector: "[itemprop='availability'], .stock-status, .availability", transform: "text" },
    breadcrumb: { selector: ".breadcrumb li a, [itemprop='itemListElement'] a, nav.breadcrumbs a", transform: "text", multiple: true },
    reviewsCount: { selector: "[itemprop='reviewCount'], .reviews-count, .review-count", transform: "number" },
  },
  article: {
    title: { selector: "h1, article h1, .post-title, .entry-title", transform: "text" },
    author: { selector: "[rel='author'], [itemprop='author'], .author-name, .byline", transform: "text" },
    publishDate: { selector: "time[datetime], [itemprop='datePublished'], .publish-date, .post-date", attribute: "datetime" },
    content: { selector: "article, .post-content, .entry-content, .article-body, .article-content", transform: "html" },
    categories: { selector: ".category a, [rel='tag'], .post-categories a", transform: "text", multiple: true },
    tags: { selector: ".tags a, .post-tags a, .tag-links a", transform: "text", multiple: true },
  },
  "local-business": {
    name: { selector: "h1, [itemprop='name'], .business-name", transform: "text" },
    address: { selector: "[itemprop='address'], .address, address", transform: "text" },
    phone: { selector: "[itemprop='telephone'], a[href^='tel:'], .phone", transform: "text" },
    email: { selector: "[itemprop='email'], a[href^='mailto:'], .email", transform: "text" },
    hours: { selector: "[itemprop='openingHours'], .opening-hours, .business-hours", transform: "text" },
    coordinates: { selector: "[itemprop='geo']", transform: "text" },
    rating: { selector: "[itemprop='ratingValue'], .rating-value", transform: "number" },
    reviewCount: { selector: "[itemprop='reviewCount'], .review-count", transform: "number" },
  },
  recipe: {
    title: { selector: "h1, [itemprop='name']", transform: "text" },
    prepTime: { selector: "[itemprop='prepTime'], .prep-time", transform: "text" },
    cookTime: { selector: "[itemprop='cookTime'], .cook-time", transform: "text" },
    servings: { selector: "[itemprop='recipeYield'], .servings, .recipe-yield", transform: "text" },
    ingredients: { selector: "[itemprop='recipeIngredient'] li, .ingredients li, .recipe-ingredients li", transform: "text", multiple: true },
    instructions: { selector: "[itemprop='recipeInstructions'] li, .instructions ol li, .recipe-steps li", transform: "text", multiple: true },
    calories: { selector: "[itemprop='calories'], .calories, .nutrition-calories", transform: "number" },
    image: { selector: "[itemprop='image'], .recipe-image img, .recipe-hero img", attribute: "src" },
  },
};

function extractOneFromSelection(
  selection: ReturnType<cheerio.CheerioAPI>,
  field: FieldDef
): unknown {
  if (field.attribute) {
    return selection.attr(field.attribute) || undefined;
  }

  switch (field.transform) {
    case "html":
      return selection.html()?.trim() || undefined;
    case "number": {
      const text = selection.text().trim();
      const nums = text.match(/[\d.,]+/);
      if (!nums) return undefined;
      const parsed = parseFloat(nums[0].replace(",", "."));
      return isNaN(parsed) ? undefined : parsed;
    }
    case "href":
      return selection.attr("href") || undefined;
    case "trim":
      return selection.text().trim() || undefined;
    case "text":
    default:
      return selection.text().trim() || undefined;
  }
}

function extractField(
  $: cheerio.CheerioAPI,
  field: FieldDef
): unknown {
  const elements = $(field.selector);

  if (elements.length === 0) return undefined;

  if (field.multiple) {
    const results: unknown[] = [];
    for (let i = 0; i < elements.length; i++) {
      const val = extractOneFromSelection(elements.eq(i), field);
      if (val !== undefined) results.push(val);
    }
    return results.length > 0 ? results : undefined;
  }

  return extractOneFromSelection(elements.first(), field);
}

export async function extractWithSchema({
  url,
  schema,
  fallbackSelectors,
  preset,
}: {
  url: string;
  schema?: Record<string, { selector: string; attribute?: string; multiple?: boolean; transform?: "text" | "html" | "number" | "trim" | "href" }>;
  fallbackSelectors?: Record<string, { selector: string; attribute?: string; multiple?: boolean; transform?: "text" | "html" | "number" | "trim" | "href" }>;
  preset?: "ecommerce-product" | "article" | "local-business" | "recipe";
}): Promise<StandardResponse> {
  const startTime = performance.now();

  // Build effective schema: preset as base, schema overrides
  let effectiveSchema: SchemaMap = {};
  if (preset && PRESETS[preset]) {
    effectiveSchema = { ...PRESETS[preset] };
  }
  if (schema) {
    effectiveSchema = { ...effectiveSchema, ...schema };
  }

  if (Object.keys(effectiveSchema).length === 0) {
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `extract_with_schema: aucun schema fourni (ni schema ni preset)`,
      issues: [createIssue("error", "no-schema", "No schema or preset provided. Provide a schema object or a preset name.")],
      recommendations: ["Provide a 'schema' object or use a 'preset' (ecommerce-product, article, local-business, recipe)"],
      meta: createMeta(startTime, "fetch", false, false),
      data: {
        extracted: {},
        fieldsFound: 0,
        fieldsTotal: 0,
        fieldsMissing: [],
        usedFallback: [],
        preset: preset || null,
      },
    };
  }

  const fetchResult = await fetchUrl(url, { timeout: 15000, maxRetries: 1 });
  const $ = cheerio.load(fetchResult.body);

  const extracted: Record<string, unknown> = {};
  const fieldsMissing: string[] = [];
  const usedFallback: string[] = [];
  let fieldsFound = 0;
  const fieldsTotal = Object.keys(effectiveSchema).length;

  for (const [fieldName, fieldDef] of Object.entries(effectiveSchema)) {
    let value = extractField($, fieldDef);

    if (value === undefined && fallbackSelectors && fallbackSelectors[fieldName]) {
      value = extractField($, fallbackSelectors[fieldName]);
      if (value !== undefined) {
        usedFallback.push(fieldName);
      }
    }

    if (value !== undefined) {
      extracted[fieldName] = value;
      fieldsFound++;
    } else {
      fieldsMissing.push(fieldName);
    }
  }

  // Special: for article preset, compute readingTime from content
  if (preset === "article" && extracted.content && typeof extracted.content === "string") {
    const wordCount = extracted.content.replace(/<[^>]*>/g, "").split(/\s+/).filter(Boolean).length;
    extracted.readingTime = `${Math.ceil(wordCount / 200)} min`;
  }

  const score = fieldsTotal > 0 ? Math.round((fieldsFound / fieldsTotal) * 100) : 0;

  const issues = [];
  if (fieldsMissing.length > 0) {
    issues.push(createIssue(
      fieldsMissing.length > fieldsTotal / 2 ? "error" : "warning",
      "missing-fields",
      `${fieldsMissing.length} field(s) not found: ${fieldsMissing.join(", ")}`
    ));
  }
  if (usedFallback.length > 0) {
    issues.push(createIssue(
      "info",
      "fallback-used",
      `Fallback selectors used for: ${usedFallback.join(", ")}`
    ));
  }

  return {
    url,
    finalUrl: fetchResult.finalUrl,
    status: fetchResult.status,
    score,
    summary: `extract_with_schema de ${url}: ${fieldsFound}/${fieldsTotal} champs extraits${preset ? ` (preset: ${preset})` : ""}`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, fetchResult.fetchedWith, false, fetchResult.partial),
    data: {
      extracted,
      fieldsFound,
      fieldsTotal,
      fieldsMissing,
      usedFallback,
      preset: preset || null,
    },
  };
}
