import { z } from "zod";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkAccessibilitySchema = {
  url: z.string().url().describe("The URL of the page to audit"),
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

// -------- constants --------

const VALID_ARIA_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

// Generic link texts (lowercased, normalized whitespace) — FR, NL, EN, DE.
const GENERIC_LINK_TEXTS = new Set([
  // English
  "click here",
  "click",
  "read more",
  "more",
  "here",
  "link",
  "this link",
  "learn more",
  "more info",
  "details",
  // French
  "cliquez ici",
  "cliquer ici",
  "lire la suite",
  "en savoir plus",
  "plus",
  "ici",
  "lien",
  "voir plus",
  "plus d'infos",
  "détails",
  // Dutch
  "klik hier",
  "meer lezen",
  "lees meer",
  "hier",
  "meer",
  "meer info",
  // German
  "hier klicken",
  "mehr erfahren",
  "weiterlesen",
  "hier",
  "mehr",
  "mehr infos",
]);

// Intrinsic HTML element → implicit ARIA role (subset, common cases)
const IMPLICIT_ROLES: Record<string, string> = {
  a: "link",
  article: "article",
  aside: "complementary",
  button: "button",
  datalist: "listbox",
  dd: "definition",
  details: "group",
  dialog: "dialog",
  dt: "term",
  fieldset: "group",
  figure: "figure",
  footer: "contentinfo",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  header: "banner",
  hr: "separator",
  li: "listitem",
  main: "main",
  menu: "list",
  nav: "navigation",
  ol: "list",
  option: "option",
  output: "status",
  progress: "progressbar",
  section: "region",
  select: "listbox",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  tfoot: "rowgroup",
  th: "columnheader",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "yi", "ps"]);

const FOCUSABLE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "audio",
  "video",
]);

// -------- helpers --------

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(s: string, maxLen = 120): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function getElementSnippet($: CheerioAPI, el: AnyElement): string {
  const full = $.html(el as never) || "";
  // Prefer just the opening tag for readability
  const opening = full.match(/^<[^>]*>/);
  const snippet = opening ? opening[0] : full;
  return truncate(snippet, 120);
}

// Minimal CSS selector path for an element (best-effort, not guaranteed unique).
function getCssSelector(el: AnyElement): string {
  const parts: string[] = [];
  let current: AnyElement | null = el;
  while (current && current.type === "tag" && current.tagName !== "html") {
    let part = current.tagName;
    const attribs: Record<string, string> = current.attribs || {};
    if (attribs.id && /^[\w-]+$/.test(attribs.id)) {
      parts.unshift(`${part}#${attribs.id}`);
      break;
    }
    if (attribs.class) {
      const firstClass = attribs.class.trim().split(/\s+/)[0];
      if (firstClass && /^[\w-]+$/.test(firstClass)) {
        part += `.${firstClass}`;
      }
    }
    const parent: AnyElement | null | undefined = current.parent;
    if (parent && parent.type === "tag") {
      const tagName = current.tagName;
      const siblings = (parent.children || []).filter(
        (c: AnyElement) => c && c.type === "tag" && c.tagName === tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    current = parent && parent.type === "tag" ? parent : null;
  }
  return parts.join(" > ");
}

// Walk up the parent chain looking for an element that matches `tagName`.
function hasAncestor(el: AnyElement, tagName: string): boolean {
  let current = el.parent;
  while (current) {
    if (current.type === "tag" && current.tagName === tagName) return true;
    current = current.parent;
  }
  return false;
}

// Loose type — cheerio exposes domhandler Elements but we avoid a direct
// dependency import by using a structural type.
interface AnyElement {
  type: string;
  tagName: string;
  attribs?: Record<string, string>;
  children?: AnyElement[];
  parent?: AnyElement | null;
}

// -------- issue accumulator --------

export type A11ySeverity = "critical" | "major" | "minor" | "info";

export interface A11yIssue {
  severity: A11ySeverity;
  category: string;
  wcag: string;
  element: string;
  message: string;
  selector: string;
}

interface CategoryResult {
  score: number;
  max: number;
  issues: A11yIssue[];
}

function emptyCategory(max: number): CategoryResult {
  return { score: max, max, issues: [] };
}

// -------- A. Images (15 points) --------

function checkImages($: CheerioAPI): CategoryResult {
  const result = emptyCategory(15);
  const images = $("img").toArray() as unknown as AnyElement[];
  const svgs = $("svg").toArray() as unknown as AnyElement[];
  const inputImages = $('input[type="image"]').toArray() as unknown as AnyElement[];

  const total = images.length + svgs.length + inputImages.length;
  let compliant = 0;

  for (const img of images) {
    const attribs = img.attribs || {};
    const alt = attribs.alt;
    const role = (attribs.role || "").toLowerCase();
    const ariaHidden = (attribs["aria-hidden"] || "").toLowerCase();
    const isDecorative =
      alt === "" || role === "presentation" || role === "none" || ariaHidden === "true";

    if (alt === undefined) {
      result.issues.push({
        severity: "critical",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, img),
        message: "Image missing alt attribute",
        selector: getCssSelector(img),
      });
      continue;
    }

    if (isDecorative) {
      compliant++;
      continue;
    }

    // Significant image — check alt quality
    const altText = alt.trim().toLowerCase();
    const src = (attribs.src || "").toLowerCase();
    const filename = src.split("/").pop() || "";
    const badAlts = new Set(["image", "img", "photo", "picture", "icon", "logo"]);

    if (altText.length <= 3) {
      result.issues.push({
        severity: "major",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, img),
        message: `Image alt text is too short ('${alt}') — use descriptive text`,
        selector: getCssSelector(img),
      });
    } else if (badAlts.has(altText)) {
      result.issues.push({
        severity: "major",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, img),
        message: `Image alt text is generic ('${alt}') — describe the image content`,
        selector: getCssSelector(img),
      });
    } else if (filename && altText === filename) {
      result.issues.push({
        severity: "major",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, img),
        message: "Image alt text is the filename — use a descriptive alt",
        selector: getCssSelector(img),
      });
    } else {
      compliant++;
    }
  }

  // Inline SVGs: accept if they have role="presentation"/"img"+label, aria-hidden, or <title>
  for (const svg of svgs) {
    const attribs = svg.attribs || {};
    const role = (attribs.role || "").toLowerCase();
    const ariaHidden = (attribs["aria-hidden"] || "").toLowerCase();
    if (role === "presentation" || role === "none" || ariaHidden === "true") {
      compliant++;
      continue;
    }
    const hasTitle = $(svg as never).children("title").length > 0;
    const hasAriaLabel =
      !!attribs["aria-label"] || !!attribs["aria-labelledby"];
    if (hasTitle || hasAriaLabel) {
      compliant++;
    } else {
      result.issues.push({
        severity: "major",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, svg),
        message: "Inline SVG missing accessible name (<title>, aria-label, or aria-labelledby)",
        selector: getCssSelector(svg),
      });
    }
  }

  for (const inp of inputImages) {
    const attribs = inp.attribs || {};
    if (attribs.alt !== undefined && attribs.alt.trim().length > 0) {
      compliant++;
    } else {
      result.issues.push({
        severity: "critical",
        category: "images",
        wcag: "1.1.1",
        element: getElementSnippet($, inp),
        message: "<input type=\"image\"> missing alt attribute",
        selector: getCssSelector(inp),
      });
    }
  }

  if (total > 0) {
    result.score = Math.round((compliant / total) * 15);
  }
  return result;
}

// -------- B. Forms (15 points) --------

function checkForms($: CheerioAPI): CategoryResult {
  const result = emptyCategory(15);
  const fields = $(
    "input, select, textarea"
  ).toArray() as unknown as AnyElement[];

  const filtered = fields.filter((el) => {
    if (el.tagName !== "input") return true;
    const type = ((el.attribs || {}).type || "text").toLowerCase();
    return !["hidden", "submit", "button", "image", "reset"].includes(type);
  });

  let compliant = 0;
  for (const field of filtered) {
    const attribs = field.attribs || {};
    const id = attribs.id;
    const hasLabelFor =
      !!id && $(`label[for="${id.replace(/"/g, '\\"')}"]`).length > 0;
    const hasParentLabel = hasAncestor(field, "label");
    const hasAriaLabel = !!attribs["aria-label"];
    const hasAriaLabelledBy = !!attribs["aria-labelledby"];
    const hasTitle = !!attribs.title;

    if (
      hasLabelFor ||
      hasParentLabel ||
      hasAriaLabel ||
      hasAriaLabelledBy ||
      hasTitle
    ) {
      compliant++;
    } else {
      result.issues.push({
        severity: "critical",
        category: "forms",
        wcag: "3.3.2",
        element: getElementSnippet($, field),
        message: `Form field has no accessible label (${field.tagName}${attribs.name ? `[name=${attribs.name}]` : ""})`,
        selector: getCssSelector(field),
      });
    }
  }

  // fieldset must have legend
  const fieldsets = $("fieldset").toArray() as unknown as AnyElement[];
  let fieldsetTotal = 0;
  let fieldsetOk = 0;
  for (const fs of fieldsets) {
    fieldsetTotal++;
    if ($(fs as never).children("legend").length > 0) {
      fieldsetOk++;
    } else {
      result.issues.push({
        severity: "major",
        category: "forms",
        wcag: "1.3.1",
        element: getElementSnippet($, fs),
        message: "<fieldset> is missing a <legend>",
        selector: getCssSelector(fs),
      });
    }
  }

  // required field indicator
  const requiredFields = filtered.filter((el) => {
    const a = el.attribs || {};
    return a.required !== undefined || a["aria-required"] === "true";
  });
  // informational only — no deduction for having required fields

  const totalChecked = filtered.length + fieldsetTotal;
  const totalOk = compliant + fieldsetOk;
  if (totalChecked > 0) {
    result.score = Math.round((totalOk / totalChecked) * 15);
  }
  // unused but kept for clarity
  void requiredFields;
  return result;
}

// -------- C. Semantic structure (15 points) --------

function checkSemanticStructure($: CheerioAPI): CategoryResult {
  const result = emptyCategory(15);
  let score = 0;

  const mainCount =
    $("main").length + $('[role="main"]:not(main)').length;
  const navCount =
    $("nav").length + $('[role="navigation"]:not(nav)').length;
  const headerCount =
    $("header").length + $('[role="banner"]:not(header)').length;
  const footerCount =
    $("footer").length + $('[role="contentinfo"]:not(footer)').length;

  if (mainCount >= 1) {
    score += 3;
  } else {
    result.issues.push({
      severity: "major",
      category: "semanticStructure",
      wcag: "1.3.1",
      element: "<body>",
      message: "Page has no <main> or [role=\"main\"] landmark",
      selector: "body",
    });
  }

  if (mainCount > 1) {
    result.issues.push({
      severity: "major",
      category: "semanticStructure",
      wcag: "1.3.1",
      element: "<main>",
      message: `Page has ${mainCount} <main> landmarks — there should be only one`,
      selector: "main",
    });
    score -= 1;
  }

  if (navCount >= 1) {
    score += 3;
  } else {
    result.issues.push({
      severity: "minor",
      category: "semanticStructure",
      wcag: "1.3.1",
      element: "<body>",
      message: "Page has no <nav> or [role=\"navigation\"] landmark",
      selector: "body",
    });
  }

  if (headerCount >= 1) {
    score += 3;
  } else {
    result.issues.push({
      severity: "minor",
      category: "semanticStructure",
      wcag: "1.3.1",
      element: "<body>",
      message: "Page has no <header> or [role=\"banner\"] landmark",
      selector: "body",
    });
  }

  if (footerCount >= 1) {
    score += 3;
  } else {
    result.issues.push({
      severity: "minor",
      category: "semanticStructure",
      wcag: "1.3.1",
      element: "<body>",
      message: "Page has no <footer> or [role=\"contentinfo\"] landmark",
      selector: "body",
    });
  }

  // lang attribute
  const htmlEl = $("html");
  const lang = (htmlEl.attr("lang") || "").trim();
  const langCode = lang.split("-")[0].toLowerCase();
  const validLang = /^[a-z]{2,3}$/.test(langCode);
  if (!lang) {
    result.issues.push({
      severity: "critical",
      category: "semanticStructure",
      wcag: "3.1.1",
      element: "<html>",
      message: "<html> is missing the lang attribute",
      selector: "html",
    });
  } else if (!validLang) {
    result.issues.push({
      severity: "major",
      category: "semanticStructure",
      wcag: "3.1.1",
      element: `<html lang="${lang}">`,
      message: `<html> lang attribute '${lang}' is not a valid language code`,
      selector: "html",
    });
  } else {
    score += 3;
  }

  // RTL dir check
  if (validLang && RTL_LANGUAGES.has(langCode)) {
    const dir = (htmlEl.attr("dir") || "").toLowerCase();
    if (dir !== "rtl") {
      result.issues.push({
        severity: "major",
        category: "semanticStructure",
        wcag: "1.3.2",
        element: `<html lang="${lang}">`,
        message: `Language '${langCode}' is right-to-left — <html> should have dir="rtl"`,
        selector: "html",
      });
    }
  }

  // Skip link check — look for a link in the first few body children pointing to #main/#content
  const skipTargets = new Set(["#main", "#content", "#main-content", "#skip", "#skiptocontent"]);
  const firstLinks = $("body")
    .find("a[href]")
    .slice(0, 3)
    .toArray() as unknown as AnyElement[];
  const hasSkipLink = firstLinks.some((el) => {
    const href = (el.attribs || {}).href || "";
    return skipTargets.has(href.toLowerCase());
  });
  if (!hasSkipLink) {
    result.issues.push({
      severity: "info",
      category: "semanticStructure",
      wcag: "2.4.1",
      element: "<body>",
      message: "No skip link detected (consider adding a \"Skip to main content\" link as the first focusable element)",
      selector: "body",
    });
  }

  result.score = Math.max(0, Math.min(15, score));
  return result;
}

// -------- D. Heading hierarchy (10 points) --------

function checkHeadingHierarchy($: CheerioAPI): CategoryResult {
  const result = emptyCategory(10);
  const headings = $(
    "h1, h2, h3, h4, h5, h6"
  ).toArray() as unknown as AnyElement[];

  let score = 10;
  const h1s = headings.filter((h) => h.tagName === "h1");

  if (h1s.length === 0) {
    result.issues.push({
      severity: "critical",
      category: "headingHierarchy",
      wcag: "1.3.1",
      element: "<body>",
      message: "Page has no <h1> heading",
      selector: "body",
    });
    score -= 5;
  } else if (h1s.length > 1) {
    result.issues.push({
      severity: "major",
      category: "headingHierarchy",
      wcag: "1.3.1",
      element: getElementSnippet($, h1s[1]),
      message: `Page has ${h1s.length} <h1> headings — use only one`,
      selector: getCssSelector(h1s[1]),
    });
    score -= 2;
  }

  let prev = 0;
  let brokenCount = 0;
  for (const h of headings) {
    const level = parseInt(h.tagName.charAt(1), 10);
    if (prev > 0 && level > prev + 1) {
      brokenCount++;
      if (brokenCount === 1) {
        result.issues.push({
          severity: "major",
          category: "headingHierarchy",
          wcag: "1.3.1",
          element: getElementSnippet($, h),
          message: `Heading hierarchy skips from H${prev} to H${level}`,
          selector: getCssSelector(h),
        });
      }
    }
    prev = level;

    const text = normalizeText($(h as never).text());
    if (text.length === 0) {
      result.issues.push({
        severity: "major",
        category: "headingHierarchy",
        wcag: "2.4.6",
        element: getElementSnippet($, h),
        message: `Empty <${h.tagName}> heading`,
        selector: getCssSelector(h),
      });
      score -= 1;
    }
  }

  if (brokenCount > 0) {
    score -= 3;
  }

  result.score = Math.max(0, score);
  return result;
}

// -------- E. Links (10 points) --------

function checkLinks($: CheerioAPI): CategoryResult {
  const result = emptyCategory(10);
  const links = $("a[href]").toArray() as unknown as AnyElement[];
  if (links.length === 0) return result;

  let compliant = 0;
  for (const a of links) {
    const attribs = a.attribs || {};
    const text = normalizeText($(a as never).text());
    const ariaLabel = (attribs["aria-label"] || "").trim();
    const ariaLabelledBy = (attribs["aria-labelledby"] || "").trim();
    const title = (attribs.title || "").trim();
    const hasImgAlt = $(a as never)
      .find("img[alt]")
      .toArray()
      .some((img) => ((img as AnyElement).attribs?.alt || "").trim().length > 0);

    const accessibleName = ariaLabel || ariaLabelledBy || text || title || (hasImgAlt ? "img" : "");
    if (!accessibleName) {
      result.issues.push({
        severity: "critical",
        category: "links",
        wcag: "2.4.4",
        element: getElementSnippet($, a),
        message: "Empty link — no text, aria-label, title, or image alt",
        selector: getCssSelector(a),
      });
      continue;
    }

    // Check for generic link text (only when no aria-label overrides it)
    const effectiveText = (ariaLabel || text).toLowerCase();
    if (!ariaLabel && GENERIC_LINK_TEXTS.has(effectiveText)) {
      result.issues.push({
        severity: "major",
        category: "links",
        wcag: "2.4.4",
        element: getElementSnippet($, a),
        message: `Link text is generic ('${text}') — use descriptive text or add aria-label`,
        selector: getCssSelector(a),
      });
      continue;
    }

    // target="_blank" must indicate new window via text or aria-label
    const target = (attribs.target || "").toLowerCase();
    if (target === "_blank") {
      const combined = `${effectiveText} ${title}`.toLowerCase();
      const mentionsNewWindow =
        /new\s+window|new\s+tab|nouvelle\s+fen[eê]tre|nouvel\s+onglet|nieuw\s+venster|nieuw\s+tabblad|neues\s+fenster|neuer\s+tab/.test(
          combined
        );
      if (!mentionsNewWindow) {
        result.issues.push({
          severity: "minor",
          category: "links",
          wcag: "3.2.5",
          element: getElementSnippet($, a),
          message:
            "Link with target=\"_blank\" does not announce that it opens in a new window",
          selector: getCssSelector(a),
        });
        continue;
      }
    }

    compliant++;
  }

  result.score = Math.round((compliant / links.length) * 10);
  return result;
}

// -------- F. Contrast and visuals (10 points) --------

function checkContrastAndVisuals($: CheerioAPI): CategoryResult {
  const result = emptyCategory(10);
  let score = 10;

  // Viewport zoom lockdown
  const viewport = $('meta[name="viewport"]').attr("content") || "";
  const viewportLower = viewport.toLowerCase().replace(/\s+/g, "");
  if (
    viewportLower.includes("user-scalable=no") ||
    viewportLower.includes("user-scalable=0") ||
    /maximum-scale=1(?:\.0+)?(?:[,;]|$)/.test(viewportLower)
  ) {
    result.issues.push({
      severity: "critical",
      category: "contrastAndVisuals",
      wcag: "1.4.4",
      element: `<meta name="viewport" content="${truncate(viewport, 80)}">`,
      message:
        "Viewport disables user zoom (user-scalable=no or maximum-scale=1)",
      selector: 'meta[name="viewport"]',
    });
    score -= 5;
  }

  // Inline font-size < 12px on text elements
  const textTags = "p, span, li, a, div, td, th, label, button";
  const smallFontEls: AnyElement[] = [];
  $(textTags).each((_, el) => {
    const style = ($(el).attr("style") || "").toLowerCase();
    const m = style.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/);
    if (m) {
      const px = parseFloat(m[1]);
      if (px < 12) {
        smallFontEls.push(el as unknown as AnyElement);
      }
    }
  });
  if (smallFontEls.length > 0) {
    result.issues.push({
      severity: "minor",
      category: "contrastAndVisuals",
      wcag: "1.4.4",
      element: getElementSnippet($, smallFontEls[0]),
      message: `${smallFontEls.length} element(s) use inline font-size smaller than 12px`,
      selector: getCssSelector(smallFontEls[0]),
    });
    score -= 2;
  }

  // user-select: none !important on body
  const bodyStyle = ($("body").attr("style") || "").toLowerCase();
  if (/user-select\s*:\s*none\s*!important/.test(bodyStyle)) {
    result.issues.push({
      severity: "major",
      category: "contrastAndVisuals",
      wcag: "1.4.4",
      element: "<body>",
      message:
        "Body has user-select: none !important — prevents users from selecting text",
      selector: "body",
    });
    score -= 3;
  }

  result.score = Math.max(0, score);
  return result;
}

// -------- G. Tables (5 points) --------

function checkTables($: CheerioAPI): CategoryResult {
  const result = emptyCategory(5);
  const tables = $("table").toArray() as unknown as AnyElement[];
  if (tables.length === 0) return result;

  let compliant = 0;
  for (const table of tables) {
    const attribs = table.attribs || {};
    const role = (attribs.role || "").toLowerCase();
    if (role === "presentation" || role === "none") {
      compliant++;
      continue;
    }

    const $table = $(table as never);
    const hasCaption = $table.children("caption").length > 0;
    const hasAriaLabel =
      !!attribs["aria-label"] || !!attribs["aria-labelledby"] || !!attribs["aria-describedby"];
    const ths = $table.find("th").toArray() as unknown as AnyElement[];
    const hasThs = ths.length > 0;
    const thsWithScope = ths.filter(
      (th) => !!((th.attribs || {}).scope || "")
    ).length;

    if (!hasCaption && !hasAriaLabel && !hasThs) {
      // Likely a layout table without role=presentation
      result.issues.push({
        severity: "major",
        category: "tables",
        wcag: "1.3.1",
        element: getElementSnippet($, table),
        message:
          "Table has no <caption>, aria-label, or <th> — add role=\"presentation\" if used for layout",
        selector: getCssSelector(table),
      });
      continue;
    }

    let ok = true;
    if (!hasCaption && !hasAriaLabel) {
      result.issues.push({
        severity: "major",
        category: "tables",
        wcag: "1.3.1",
        element: getElementSnippet($, table),
        message: "Data table is missing a <caption> or aria-label",
        selector: getCssSelector(table),
      });
      ok = false;
    }
    if (hasThs && thsWithScope < ths.length) {
      result.issues.push({
        severity: "minor",
        category: "tables",
        wcag: "1.3.1",
        element: getElementSnippet($, table),
        message: `${ths.length - thsWithScope} <th> element(s) missing scope attribute`,
        selector: getCssSelector(table),
      });
      ok = false;
    }
    if (ok) compliant++;
  }

  result.score = Math.round((compliant / tables.length) * 5);
  return result;
}

// -------- H. Media (5 points) --------

function checkMedia($: CheerioAPI): CategoryResult {
  const result = emptyCategory(5);
  const videos = $("video").toArray() as unknown as AnyElement[];
  const audios = $("audio").toArray() as unknown as AnyElement[];
  const iframes = $("iframe").toArray() as unknown as AnyElement[];

  const total = videos.length + audios.length + iframes.length;
  if (total === 0) return result;

  let compliant = 0;
  for (const v of videos) {
    if ((v.attribs || {}).controls !== undefined) {
      compliant++;
    } else {
      result.issues.push({
        severity: "major",
        category: "media",
        wcag: "2.1.1",
        element: getElementSnippet($, v),
        message: "<video> missing controls attribute",
        selector: getCssSelector(v),
      });
    }
  }
  for (const a of audios) {
    if ((a.attribs || {}).controls !== undefined) {
      compliant++;
    } else {
      result.issues.push({
        severity: "major",
        category: "media",
        wcag: "2.1.1",
        element: getElementSnippet($, a),
        message: "<audio> missing controls attribute",
        selector: getCssSelector(a),
      });
    }
  }
  for (const f of iframes) {
    const attribs = f.attribs || {};
    const title = (attribs.title || "").trim();
    const ariaLabel = (attribs["aria-label"] || "").trim();
    if (title || ariaLabel) {
      compliant++;
    } else {
      result.issues.push({
        severity: "major",
        category: "media",
        wcag: "4.1.2",
        element: getElementSnippet($, f),
        message: "<iframe> missing title attribute",
        selector: getCssSelector(f),
      });
    }
  }

  result.score = Math.round((compliant / total) * 5);
  return result;
}

// -------- I. ARIA usage (10 points) --------

function checkAriaUsage($: CheerioAPI): CategoryResult {
  const result = emptyCategory(10);
  let score = 10;

  // Collect all existing IDs for reference validation
  const existingIds = new Set<string>();
  $("[id]").each((_, el) => {
    const id = ($(el).attr("id") || "").trim();
    if (id) existingIds.add(id);
  });

  // Invalid roles
  $("[role]").each((_, el) => {
    const role = ($(el).attr("role") || "").trim().toLowerCase();
    if (!role) return;
    // Multiple roles allowed (space-separated); check each token
    const tokens = role.split(/\s+/);
    const invalid = tokens.filter((t) => !VALID_ARIA_ROLES.has(t));
    if (invalid.length > 0) {
      const ae = el as unknown as AnyElement;
      result.issues.push({
        severity: "major",
        category: "ariaUsage",
        wcag: "4.1.2",
        element: getElementSnippet($, ae),
        message: `Invalid ARIA role '${invalid.join(" ")}'`,
        selector: getCssSelector(ae),
      });
      score -= 2;
    }
  });

  // aria-labelledby / aria-describedby references
  const checkRefs = (attr: string) => {
    $(`[${attr}]`).each((_, el) => {
      const ids = ($(el).attr(attr) || "").trim().split(/\s+/).filter(Boolean);
      const missing = ids.filter((id) => !existingIds.has(id));
      if (missing.length > 0) {
        const ae = el as unknown as AnyElement;
        result.issues.push({
          severity: "major",
          category: "ariaUsage",
          wcag: "4.1.2",
          element: getElementSnippet($, ae),
          message: `${attr} references missing ID(s): ${missing.join(", ")}`,
          selector: getCssSelector(ae),
        });
        score -= 2;
      }
    });
  };
  checkRefs("aria-labelledby");
  checkRefs("aria-describedby");

  // Redundant ARIA (implicit role matches explicit role)
  $("[role]").each((_, el) => {
    const ae = el as unknown as AnyElement;
    const tag = ae.tagName;
    const implicit = IMPLICIT_ROLES[tag];
    const role = ($(el).attr("role") || "").trim().toLowerCase().split(/\s+/)[0];
    if (implicit && implicit === role) {
      result.issues.push({
        severity: "minor",
        category: "ariaUsage",
        wcag: "4.1.2",
        element: getElementSnippet($, ae),
        message: `Redundant ARIA role: <${tag}> already has implicit role="${implicit}"`,
        selector: getCssSelector(ae),
      });
      score -= 1;
    }
  });

  // aria-hidden on focusable elements
  $('[aria-hidden="true"]').each((_, el) => {
    const ae = el as unknown as AnyElement;
    const tag = ae.tagName;
    const attribs = ae.attribs || {};
    const tabindex = attribs.tabindex;
    const isFocusableTag = FOCUSABLE_TAGS.has(tag);
    const isNativelyFocusable =
      isFocusableTag &&
      !(tag === "input" && (attribs.type || "").toLowerCase() === "hidden");
    const explicitlyHiddenFromTab = tabindex === "-1";
    if (isNativelyFocusable && !explicitlyHiddenFromTab) {
      result.issues.push({
        severity: "major",
        category: "ariaUsage",
        wcag: "4.1.2",
        element: getElementSnippet($, ae),
        message:
          "aria-hidden=\"true\" on a focusable element — also set tabindex=\"-1\" or remove from focus order",
        selector: getCssSelector(ae),
      });
      score -= 2;
    }
  });

  result.score = Math.max(0, score);
  return result;
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

export async function checkAccessibility({
  url,
  timeout,
}: {
  url: string;
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

  const images = checkImages($);
  const forms = checkForms($);
  const semanticStructure = checkSemanticStructure($);
  const headingHierarchy = checkHeadingHierarchy($);
  const links = checkLinks($);
  const contrastAndVisuals = checkContrastAndVisuals($);
  const tables = checkTables($);
  const media = checkMedia($);
  const ariaUsage = checkAriaUsage($);

  const categories = {
    images,
    forms,
    semanticStructure,
    headingHierarchy,
    links,
    contrastAndVisuals,
    tables,
    media,
    ariaUsage,
  };

  const rawSum = Object.values(categories).reduce((s, c) => s + c.score, 0);
  const rawMax = Object.values(categories).reduce((s, c) => s + c.max, 0);
  const finalScore = rawMax > 0 ? Math.round((rawSum / rawMax) * 100) : 0;

  let grade: "A" | "B" | "C" | "D" | "F";
  if (finalScore >= 90) grade = "A";
  else if (finalScore >= 70) grade = "B";
  else if (finalScore >= 50) grade = "C";
  else if (finalScore >= 30) grade = "D";
  else grade = "F";

  const allIssues: A11yIssue[] = Object.values(categories).flatMap(
    (c) => c.issues
  );

  const summary = {
    totalIssues: allIssues.length,
    critical: allIssues.filter((i) => i.severity === "critical").length,
    major: allIssues.filter((i) => i.severity === "major").length,
    minor: allIssues.filter((i) => i.severity === "minor").length,
    info: allIssues.filter((i) => i.severity === "info").length,
  };

  const categoryScoresOut: Record<
    string,
    { score: number; max: number; issues: number }
  > = {};
  for (const [name, cat] of Object.entries(categories)) {
    categoryScoresOut[name] = {
      score: cat.score,
      max: cat.max,
      issues: cat.issues.length,
    };
  }

  // WCAG coverage summary
  const checkedCriteria = new Set<string>([
    "1.1.1",
    "1.3.1",
    "1.3.2",
    "1.4.4",
    "2.1.1",
    "2.4.1",
    "2.4.4",
    "2.4.6",
    "3.1.1",
    "3.2.5",
    "3.3.2",
    "4.1.2",
  ]);
  const violatedCriteria = new Set(allIssues.map((i) => i.wcag));
  const wcagCoverage: Record<string, "checked" | "partial" | "not-checked"> =
    {};
  for (const c of checkedCriteria) {
    wcagCoverage[c] = violatedCriteria.has(c) ? "partial" : "checked";
  }
  wcagCoverage["4.1.1"] = "not-checked"; // parsing / DOM validity not audited here

  // Build standard ToolIssue list (top-level)
  const stdIssues = allIssues.map((i) =>
    createIssue(
      i.severity === "critical" || i.severity === "major" ? "error" :
      i.severity === "minor" ? "warning" : "info",
      `${i.category}:${i.wcag}`,
      `${i.message} (${i.selector || "n/a"})`
    )
  );

  return {
    url,
    finalUrl,
    status,
    score: finalScore,
    summary: `Audit accessibilité de ${url}: score ${finalScore}/100 (grade ${grade}, ${summary.totalIssues} issues: ${summary.critical} critical, ${summary.major} major, ${summary.minor} minor, ${summary.info} info)`,
    issues: stdIssues,
    recommendations: generateRecommendations(stdIssues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      grade,
      summary,
      categoryScores: categoryScoresOut,
      issues: allIssues,
      wcagCoverage,
    },
  };
}
