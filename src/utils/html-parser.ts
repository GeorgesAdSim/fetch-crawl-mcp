import * as cheerio from "cheerio";
import { resolveUrl, isInternalUrl, isHttpUrl } from "./url-utils.js";

export interface PageMetadata {
  title: string;
  description: string;
  canonical: string | null;
  robots: string | null;
  ogTags: Record<string, string>;
  twitterTags: Record<string, string>;
  lang: string | null;
}

export interface HeadingInfo {
  level: number;
  text: string;
}

export interface LinkInfo {
  href: string;
  text: string;
  rel: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

export interface ImageInfo {
  src: string;
  alt: string;
  title: string | null;
  width: string | null;
  height: string | null;
}

export function extractMetadata(html: string, baseUrl: string): PageMetadata {
  const $ = cheerio.load(html);

  const ogTags: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => {
    const prop = $(el).attr("property");
    const content = $(el).attr("content");
    if (prop && content) ogTags[prop] = content;
  });

  const twitterTags: Record<string, string> = {};
  $('meta[name^="twitter:"]').each((_, el) => {
    const name = $(el).attr("name");
    const content = $(el).attr("content");
    if (name && content) twitterTags[name] = content;
  });

  const canonicalHref = $('link[rel="canonical"]').attr("href");

  return {
    title: $("title").text().trim(),
    description:
      $('meta[name="description"]').attr("content")?.trim() || "",
    canonical: canonicalHref
      ? resolveUrl(baseUrl, canonicalHref)
      : null,
    robots: $('meta[name="robots"]').attr("content") || null,
    ogTags,
    twitterTags,
    lang: $("html").attr("lang") || null,
  };
}

export function extractHeadings(html: string): HeadingInfo[] {
  const $ = cheerio.load(html);
  const headings: HeadingInfo[] = [];

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag = (el as unknown as { tagName: string }).tagName.toLowerCase();
    const level = parseInt(tag.charAt(1), 10);
    const text = $(el).text().trim();
    if (text) headings.push({ level, text });
  });

  return headings;
}

export function extractLinks(html: string, baseUrl: string): LinkInfo[] {
  const $ = cheerio.load(html);
  const links: LinkInfo[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    const resolvedHref = resolveUrl(baseUrl, href);
    if (!isHttpUrl(resolvedHref)) return;

    const rel = $(el).attr("rel") || null;
    const text = $(el).text().trim();

    links.push({
      href: resolvedHref,
      text,
      rel,
      isInternal: isInternalUrl(baseUrl, resolvedHref),
      isNofollow: rel?.includes("nofollow") || false,
    });
  });

  return links;
}

export function extractImages(html: string, baseUrl: string): ImageInfo[] {
  const $ = cheerio.load(html);
  const images: ImageInfo[] = [];

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;

    images.push({
      src: resolveUrl(baseUrl, src),
      alt: $(el).attr("alt") || "",
      title: $(el).attr("title") || null,
      width: $(el).attr("width") || null,
      height: $(el).attr("height") || null,
    });
  });

  return images;
}

export function extractTextContent(html: string): string {
  const $ = cheerio.load(html);

  $(
    "script, style, nav, footer, header, aside, iframe, noscript, svg"
  ).remove();

  const text = $("body").text();

  return text
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);

  $(
    "script, style, nav, footer, aside, iframe, noscript, svg"
  ).remove();

  const lines: string[] = [];

  function processNode(el: Parameters<Parameters<ReturnType<typeof $>["each"]>[0]>[1]): void {
    const node = el as unknown as { type: string; data?: string; tagName?: string };
    if (node.type === "text") {
      const text = node.data?.trim();
      if (text) lines.push(text);
      return;
    }

    if (node.type !== "tag") return;
    const tag = node.tagName?.toLowerCase();
    const $el = $(el as never);

    switch (tag) {
      case "h1":
        lines.push(`\n# ${$el.text().trim()}\n`);
        return;
      case "h2":
        lines.push(`\n## ${$el.text().trim()}\n`);
        return;
      case "h3":
        lines.push(`\n### ${$el.text().trim()}\n`);
        return;
      case "h4":
        lines.push(`\n#### ${$el.text().trim()}\n`);
        return;
      case "h5":
        lines.push(`\n##### ${$el.text().trim()}\n`);
        return;
      case "h6":
        lines.push(`\n###### ${$el.text().trim()}\n`);
        return;
      case "p":
        lines.push(`\n${$el.text().trim()}\n`);
        return;
      case "a": {
        const href = $el.attr("href");
        const text = $el.text().trim();
        if (href && text) lines.push(`[${text}](${href})`);
        return;
      }
      case "img": {
        const alt = $el.attr("alt") || "";
        const src = $el.attr("src") || "";
        lines.push(`![${alt}](${src})`);
        return;
      }
      case "li":
        lines.push(`- ${$el.text().trim()}`);
        return;
      case "br":
        lines.push("\n");
        return;
      case "hr":
        lines.push("\n---\n");
        return;
      default:
        $el.contents().each((_, child) => processNode(child));
    }
  }

  $("body")
    .contents()
    .each((_, el) => processNode(el));

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractJsonLd(html: string): unknown[] {
  const $ = cheerio.load(html);
  const results: unknown[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html() || "");
      results.push(data);
    } catch {
      // Skip invalid JSON-LD
    }
  });

  return results;
}
