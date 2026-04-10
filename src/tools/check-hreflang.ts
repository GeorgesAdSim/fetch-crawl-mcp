import { z } from "zod";
import * as cheerio from "cheerio";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkHreflangSchema = {
  url: z.string().url().describe("The URL to audit for hreflang tags"),
  followAlternates: z
    .boolean()
    .default(true)
    .describe(
      "If true, fetch each alternate URL to verify reciprocity, accessibility, and language consistency"
    ),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(15000)
    .default(8000)
    .describe("Per-request timeout in milliseconds"),
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HREFLANG_CODE_REGEX = /^[a-z]{2}(-[a-z]{2})?$/i;

export function isValidHreflangCode(code: string): boolean {
  if (code.toLowerCase() === "x-default") return true;
  return HREFLANG_CODE_REGEX.test(code);
}

export interface HreflangEntry {
  hreflang: string;
  href: string;
}

export function parseLinkHeader(header: string | null): HreflangEntry[] {
  if (!header) return [];
  const entries: HreflangEntry[] = [];
  // Split on commas that precede a new <url> token
  const parts = header.split(/,(?=\s*<)/);
  for (const part of parts) {
    const urlMatch = part.match(/<([^>]+)>/);
    if (!urlMatch) continue;
    const href = urlMatch[1].trim();
    const relMatch = part.match(/rel\s*=\s*"?([^";]+)"?/i);
    if (!relMatch) continue;
    const rels = relMatch[1].trim().split(/\s+/);
    if (!rels.includes("alternate")) continue;
    const hreflangMatch = part.match(/hreflang\s*=\s*"?([^";]+)"?/i);
    if (!hreflangMatch) continue;
    entries.push({ hreflang: hreflangMatch[1].trim(), href });
  }
  return entries;
}

interface PageInfo {
  status: number;
  finalUrl: string;
  requestedUrl: string;
  hreflangs: HreflangEntry[];
  canonical: string | null;
  source: "html-head" | "http-header" | "none";
  redirected: boolean;
  error?: string;
}

async function fetchPageInfo(url: string, timeout: number): Promise<PageInfo> {
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
    const finalUrl = response.url || url;
    const linkHeader = response.headers.get("link");
    let html = "";
    try {
      html = await response.text();
    } catch {
      html = "";
    }

    const $ = cheerio.load(html);
    const htmlHreflangs: HreflangEntry[] = [];
    $('head link[rel="alternate"][hreflang]').each((_, el) => {
      const hreflang = ($(el).attr("hreflang") || "").trim();
      const href = ($(el).attr("href") || "").trim();
      if (!hreflang || !href) return;
      let resolved = href;
      try {
        resolved = new URL(href, finalUrl).href;
      } catch {
        // keep raw value
      }
      htmlHreflangs.push({ hreflang, href: resolved });
    });

    const headerHreflangs: HreflangEntry[] = parseLinkHeader(linkHeader).map(
      (e) => {
        try {
          return { hreflang: e.hreflang, href: new URL(e.href, finalUrl).href };
        } catch {
          return e;
        }
      }
    );

    let source: "html-head" | "http-header" | "none" = "none";
    let hreflangs: HreflangEntry[] = [];
    if (htmlHreflangs.length > 0) {
      source = "html-head";
      hreflangs = htmlHreflangs;
    } else if (headerHreflangs.length > 0) {
      source = "http-header";
      hreflangs = headerHreflangs;
    }

    const canonicalHref = $('head link[rel="canonical"]').first().attr("href");
    let canonical: string | null = null;
    if (canonicalHref) {
      try {
        canonical = new URL(canonicalHref, finalUrl).href;
      } catch {
        canonical = canonicalHref;
      }
    }

    return {
      status: response.status,
      finalUrl,
      requestedUrl: url,
      hreflangs,
      canonical,
      source,
      redirected: finalUrl !== url,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      status: 0,
      finalUrl: url,
      requestedUrl: url,
      hreflangs: [],
      canonical: null,
      source: "none",
      redirected: false,
      error: isAbort
        ? "timeout"
        : err instanceof Error
          ? err.message
          : "unknown",
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

interface AlternateAnalysis {
  hreflang: string;
  href: string;
  isSelf: boolean;
  status: number | null;
  reciprocal: boolean | null;
  canonicalMatch: boolean | null;
  validCode: boolean;
  redirected: boolean | null;
}

interface HreflangSummary {
  totalAlternates: number;
  validLanguageCodes: number;
  invalidLanguageCodes: number;
  accessibleUrls: number;
  inaccessibleUrls: number;
  reciprocalCount: number;
  nonReciprocalCount: number;
  hasXDefault: boolean;
  hasSelfReference: boolean;
  canonicalConflicts: number;
  languageConsistency: boolean;
}

interface HreflangIssue {
  severity: "high" | "medium" | "low";
  type: string;
  hreflang?: string;
  message: string;
}

export async function checkHreflang({
  url,
  followAlternates,
  timeout,
}: {
  url: string;
  followAlternates: boolean;
  timeout: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  const sourcePage = await fetchPageInfo(url, timeout);

  if (sourcePage.status === 0) {
    const msg =
      sourcePage.error === "timeout"
        ? `Request timed out after ${timeout}ms`
        : (sourcePage.error ?? "fetch failed");
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Impossible de récupérer ${url}: ${msg}`,
      issues: [createIssue("error", "fetch-error", msg)],
      recommendations: [`[fetch-error] ${msg}`],
      meta: createMeta(startTime, "fetch", false, true),
      data: { error: msg },
    };
  }

  // Dedupe alternates on (hreflang, href) pair
  const seen = new Set<string>();
  const alternates: HreflangEntry[] = [];
  for (const a of sourcePage.hreflangs) {
    const key = `${a.hreflang.toLowerCase()}|${a.href}`;
    if (!seen.has(key)) {
      seen.add(key);
      alternates.push(a);
    }
  }

  // No hreflang found on source page
  if (alternates.length === 0) {
    const hreflangIssues: HreflangIssue[] = [
      {
        severity: "high",
        type: "no-hreflang",
        message:
          'No hreflang declarations found (checked <link rel="alternate"> tags and Link header)',
      },
    ];
    const stdIssues = [
      createIssue(
        "error",
        "no-hreflang",
        "No hreflang declarations found on the page"
      ),
    ];
    return {
      url,
      finalUrl: sourcePage.finalUrl,
      status: sourcePage.status,
      score: 0,
      summary: `Aucun hreflang déclaré sur ${url}`,
      issues: stdIssues,
      recommendations: generateRecommendations(stdIssues),
      meta: createMeta(startTime, "fetch", false, false),
      data: {
        grade: "F",
        source: "none",
        hreflangTags: [],
        summary: {
          totalAlternates: 0,
          validLanguageCodes: 0,
          invalidLanguageCodes: 0,
          accessibleUrls: 0,
          inaccessibleUrls: 0,
          reciprocalCount: 0,
          nonReciprocalCount: 0,
          hasXDefault: false,
          hasSelfReference: false,
          canonicalConflicts: 0,
          languageConsistency: false,
        },
        hreflangIssues,
        sourceCanonical: sourcePage.canonical,
      },
    };
  }

  // Fetch alternates (unique, non-self) in parallel, concurrency 3
  const alternateResults = new Map<string, PageInfo>();
  alternateResults.set(sourcePage.finalUrl, sourcePage);
  const sourceUrlSet = new Set([sourcePage.finalUrl, url]);

  if (followAlternates) {
    const uniqueUrls = [
      ...new Set(alternates.map((a) => a.href)),
    ].filter((u) => !sourceUrlSet.has(u));
    const infos = await mapWithConcurrency(uniqueUrls, 3, (u) =>
      fetchPageInfo(u, timeout)
    );
    uniqueUrls.forEach((u, i) => alternateResults.set(u, infos[i]));
  }

  const sourceLanguages = new Set(
    alternates.map((a) => a.hreflang.toLowerCase())
  );

  const analysis: AlternateAnalysis[] = alternates.map((alt) => {
    const validCode = isValidHreflangCode(alt.hreflang);
    const isSelf = sourceUrlSet.has(alt.href);
    const altPage = alternateResults.get(alt.href);

    let status: number | null = null;
    let reciprocal: boolean | null = null;
    let canonicalMatch: boolean | null = null;
    let redirected: boolean | null = null;

    if (isSelf) {
      status = sourcePage.status;
      reciprocal = true;
      canonicalMatch =
        !sourcePage.canonical || sourceUrlSet.has(sourcePage.canonical);
      redirected = sourcePage.redirected;
    } else if (followAlternates && altPage) {
      status = altPage.status;
      redirected = altPage.redirected;
      if (altPage.status >= 200 && altPage.status < 400) {
        reciprocal = altPage.hreflangs.some(
          (h) => h.href === sourcePage.finalUrl || h.href === url
        );
        canonicalMatch =
          !altPage.canonical ||
          altPage.canonical === altPage.finalUrl ||
          altPage.canonical === alt.href;
      } else {
        reciprocal = false;
        canonicalMatch = null;
      }
    }

    return {
      hreflang: alt.hreflang,
      href: alt.href,
      isSelf,
      status,
      reciprocal,
      canonicalMatch,
      validCode,
      redirected,
    };
  });

  // Language consistency: every accessible alternate must declare the same set
  let languageConsistency = true;
  if (followAlternates) {
    for (const alt of alternates) {
      if (sourceUrlSet.has(alt.href)) continue;
      const altPage = alternateResults.get(alt.href);
      if (!altPage || altPage.status < 200 || altPage.status >= 400) continue;
      const altLangs = new Set(
        altPage.hreflangs.map((h) => h.hreflang.toLowerCase())
      );
      if (altLangs.size !== sourceLanguages.size) {
        languageConsistency = false;
        break;
      }
      let same = true;
      for (const lang of sourceLanguages) {
        if (!altLangs.has(lang)) {
          same = false;
          break;
        }
      }
      if (!same) {
        languageConsistency = false;
        break;
      }
    }
  }

  // Summary stats
  const validLanguageCodes = analysis.filter((a) => a.validCode).length;
  const invalidLanguageCodes = analysis.length - validLanguageCodes;
  const nonSelf = analysis.filter((a) => !a.isSelf);
  const accessibleUrls = analysis.filter(
    (a) => a.status !== null && a.status >= 200 && a.status < 400
  ).length;
  const inaccessibleUrls = analysis.filter(
    (a) => a.status !== null && (a.status === 0 || a.status >= 400)
  ).length;
  const reciprocalCount = analysis.filter((a) => a.reciprocal === true).length;
  const nonReciprocalCount = analysis.filter(
    (a) => a.reciprocal === false
  ).length;
  const hasXDefault = alternates.some(
    (a) => a.hreflang.toLowerCase() === "x-default"
  );
  const hasSelfReference = analysis.some((a) => a.isSelf);

  // Canonical conflicts: source canonical outside cluster + alternates whose canonical isn't self
  let canonicalConflicts = 0;
  const clusterUrls = new Set(alternates.map((a) => a.href));
  clusterUrls.add(sourcePage.finalUrl);
  if (sourcePage.canonical && !clusterUrls.has(sourcePage.canonical)) {
    canonicalConflicts++;
  }
  for (const a of analysis) {
    if (a.isSelf) continue;
    if (a.canonicalMatch === false) canonicalConflicts++;
  }

  const summary: HreflangSummary = {
    totalAlternates: alternates.length,
    validLanguageCodes,
    invalidLanguageCodes,
    accessibleUrls,
    inaccessibleUrls,
    reciprocalCount,
    nonReciprocalCount,
    hasXDefault,
    hasSelfReference,
    canonicalConflicts,
    languageConsistency,
  };

  // Structured issues
  const hreflangIssues: HreflangIssue[] = [];
  const stdIssues = [];

  for (const a of analysis) {
    if (!a.validCode) {
      hreflangIssues.push({
        severity: "high",
        type: "invalid-language-code",
        hreflang: a.hreflang,
        message: `Invalid hreflang language code "${a.hreflang}" (expected ISO 639-1 like "fr" or "fr-BE", or "x-default")`,
      });
      stdIssues.push(
        createIssue(
          "error",
          "invalid-language-code",
          `Invalid hreflang code "${a.hreflang}"`,
          a.href
        )
      );
    }

    if (followAlternates && !a.isSelf) {
      if (
        a.status !== null &&
        (a.status === 0 || a.status >= 400)
      ) {
        const msg =
          a.status === 0
            ? `Alternate ${a.href} could not be fetched (timeout or connection error)`
            : `Alternate ${a.href} returned HTTP ${a.status}`;
        hreflangIssues.push({
          severity: "high",
          type: "inaccessible-alternate",
          hreflang: a.hreflang,
          message: msg,
        });
        stdIssues.push(
          createIssue("error", "inaccessible-alternate", msg, a.href)
        );
      } else if (a.reciprocal === false) {
        hreflangIssues.push({
          severity: "high",
          type: "missing-reciprocal",
          hreflang: a.hreflang,
          message: `${a.href} does not link back to ${sourcePage.finalUrl}`,
        });
        stdIssues.push(
          createIssue(
            "error",
            "missing-reciprocal",
            `Alternate ${a.hreflang} does not link back to source`,
            a.href
          )
        );
      }

      if (a.canonicalMatch === false) {
        hreflangIssues.push({
          severity: "medium",
          type: "canonical-mismatch",
          hreflang: a.hreflang,
          message: `Alternate ${a.href} has a canonical pointing elsewhere`,
        });
        stdIssues.push(
          createIssue(
            "warning",
            "canonical-mismatch",
            `Alternate ${a.hreflang} canonical does not self-reference`,
            a.href
          )
        );
      }

      if (a.redirected) {
        hreflangIssues.push({
          severity: "medium",
          type: "redirect-alternate",
          hreflang: a.hreflang,
          message: `${a.hreflang} alternate ${a.href} redirected — hreflang should point to the final URL`,
        });
        stdIssues.push(
          createIssue(
            "warning",
            "redirect-alternate",
            `Alternate ${a.hreflang} URL redirects`,
            a.href
          )
        );
      }
    }
  }

  if (!hasXDefault) {
    hreflangIssues.push({
      severity: "medium",
      type: "missing-x-default",
      message:
        "Missing x-default hreflang — recommended as fallback for unmatched locales",
    });
    stdIssues.push(
      createIssue("warning", "missing-x-default", "Missing x-default hreflang")
    );
  }

  if (!hasSelfReference) {
    hreflangIssues.push({
      severity: "medium",
      type: "missing-self-reference",
      message: "Page does not include a self-referencing hreflang",
    });
    stdIssues.push(
      createIssue(
        "warning",
        "missing-self-reference",
        "Missing self-referencing hreflang"
      )
    );
  }

  if (followAlternates && !languageConsistency) {
    hreflangIssues.push({
      severity: "low",
      type: "language-inconsistency",
      message: "Language set is not consistent between source and alternates",
    });
    stdIssues.push(
      createIssue(
        "warning",
        "language-inconsistency",
        "Inconsistent language sets across cluster"
      )
    );
  }

  if (
    sourcePage.canonical &&
    !clusterUrls.has(sourcePage.canonical)
  ) {
    hreflangIssues.push({
      severity: "high",
      type: "canonical-conflict",
      message: `Source canonical (${sourcePage.canonical}) is not part of the hreflang cluster`,
    });
    stdIssues.push(
      createIssue(
        "error",
        "canonical-conflict",
        "Canonical points outside hreflang cluster",
        sourcePage.canonical
      )
    );
  }

  // Score breakdown (weights total 100 when followAlternates, 60 otherwise; final is normalized)
  const breakdown: Record<string, number> = {};
  const weights: Record<string, number> = {};

  weights.hreflangPresent = 10;
  breakdown.hreflangPresent = 10;

  weights.xDefault = 10;
  breakdown.xDefault = hasXDefault ? 10 : 0;

  weights.validCodes = 15;
  breakdown.validCodes =
    analysis.length > 0 ? (validLanguageCodes / analysis.length) * 15 : 0;

  weights.languageConsistency = 15;
  breakdown.languageConsistency = followAlternates
    ? languageConsistency
      ? 15
      : 0
    : 15;

  weights.canonicalConsistency = 10;
  breakdown.canonicalConsistency = Math.max(
    0,
    10 - canonicalConflicts * 5
  );

  if (followAlternates) {
    weights.accessibility = 15;
    const nonSelfCount = nonSelf.length;
    const accessibleNonSelf = nonSelf.filter(
      (a) => a.status !== null && a.status >= 200 && a.status < 400
    ).length;
    breakdown.accessibility =
      nonSelfCount > 0 ? (accessibleNonSelf / nonSelfCount) * 15 : 15;

    weights.reciprocity = 25;
    const reciprocalNonSelf = nonSelf.filter(
      (a) => a.reciprocal === true
    ).length;
    breakdown.reciprocity =
      nonSelfCount > 0 ? (reciprocalNonSelf / nonSelfCount) * 25 : 25;
  }

  const maxScore = Object.values(weights).reduce((a, b) => a + b, 0);
  const rawScore = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const score = Math.round((rawScore / maxScore) * 100);

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 90) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 50) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  return {
    url,
    finalUrl: sourcePage.finalUrl,
    status: sourcePage.status,
    score,
    summary: `Audit hreflang de ${url}: score ${score}/100 (grade ${grade}) — ${alternates.length} alternates`,
    issues: stdIssues,
    recommendations: generateRecommendations(stdIssues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      grade,
      source: sourcePage.source,
      hreflangTags: analysis,
      summary,
      hreflangIssues,
      sourceCanonical: sourcePage.canonical,
    },
  };
}
