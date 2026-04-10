import { z } from "zod";
import { withPuppeteerTimeout } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
} from "../utils/response.js";

export const checkConsentModeSchema = {
  url: z.string().url().describe("The URL of the page to audit"),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .default(5000)
    .describe(
      "Milliseconds to wait after page load to let the CMP initialize"
    ),
};

// -------- CMP detection --------

export interface CmpDetection {
  detected: boolean;
  vendor: string | null;
  version: string | null;
  tcfApiPresent: boolean;
  scriptUrl: string | null;
}

// -------- Consent mode parsing --------

export interface ConsentParameters {
  ad_storage?: string;
  analytics_storage?: string;
  ad_user_data?: string;
  ad_personalization?: string;
  functionality_storage?: string;
  personalization_storage?: string;
  security_storage?: string;
  wait_for_update?: number;
}

export interface ConsentCallInfo {
  found: boolean;
  beforeGtm: boolean;
  parameters: ConsentParameters;
}

// -------- Network analysis --------

export interface GoogleHit {
  url: string;
  gcs: string | null;
  gcd: string | null;
}

// -------- Cookies --------

export interface CookieInfo {
  name: string;
  domain: string;
  firstParty: boolean;
}

// -------- Raw page data --------

export interface RawConsentData {
  cmp: CmpDetection;
  consentDefault: ConsentCallInfo;
  consentUpdate: ConsentCallInfo;
  googleHits: GoogleHit[];
  cookies: CookieInfo[];
  pageDomain: string;
  finalUrl: string;
  status: number;
}

// Parse a gcs value like "G100" or "G111" to consent flags.
export function parseGcs(
  gcs: string
): { ad_storage: "granted" | "denied"; analytics_storage: "granted" | "denied" } | null {
  if (!/^G1[01][01]$/.test(gcs)) return null;
  return {
    ad_storage: gcs[2] === "1" ? "granted" : "denied",
    analytics_storage: gcs[3] === "1" ? "granted" : "denied",
  };
}

// -------- CMP vendor signature table --------

interface VendorSignature {
  name: string;
  globals: string[];
  scriptPatterns: RegExp[];
}

const VENDOR_SIGNATURES: VendorSignature[] = [
  {
    name: "cookiebot",
    globals: ["Cookiebot", "CookieConsent"],
    scriptPatterns: [/cookiebot\.com/i, /consent\.cookiebot\.com/i],
  },
  {
    name: "onetrust",
    globals: ["OneTrust", "OptanonWrapper", "Optanon"],
    scriptPatterns: [/onetrust\.com/i, /optanon/i, /cookielaw\.org/i],
  },
  {
    name: "didomi",
    globals: ["Didomi", "didomiOnReady"],
    scriptPatterns: [/didomi\.io/i],
  },
  {
    name: "axeptio",
    globals: ["axeptioSDK", "_axcb"],
    scriptPatterns: [/axept\.io/i, /axeptio/i],
  },
  {
    name: "complianz",
    globals: ["cmplz_manage_consent", "cmplz_all_scripts_hook"],
    scriptPatterns: [/complianz/i],
  },
  {
    name: "cookieyes",
    globals: ["cookieyes"],
    scriptPatterns: [/cookieyes\.com/i, /cky-consent/i],
  },
  {
    name: "usercentrics",
    globals: ["UC_UI", "usercentrics"],
    scriptPatterns: [/usercentrics\.eu/i, /usercentrics\.com/i],
  },
  {
    name: "iubenda",
    globals: ["_iub"],
    scriptPatterns: [/iubenda\.com/i],
  },
];

export function matchVendor(
  globals: string[],
  scriptUrls: string[]
): { vendor: string; scriptUrl: string | null } | null {
  const globalsSet = new Set(globals);
  for (const sig of VENDOR_SIGNATURES) {
    const hasGlobal = sig.globals.some((g) => globalsSet.has(g));
    let matchedScript: string | null = null;
    for (const url of scriptUrls) {
      if (sig.scriptPatterns.some((p) => p.test(url))) {
        matchedScript = url;
        break;
      }
    }
    if (hasGlobal || matchedScript) {
      return { vendor: sig.name, scriptUrl: matchedScript };
    }
  }
  return null;
}

// -------- Analyzer --------

export interface ConsentAnalysisResult {
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  cmp: CmpDetection;
  consentMode: {
    detected: boolean;
    version: "v1" | "v2" | null;
    defaultConsent: ConsentCallInfo;
    updateConsent: ConsentCallInfo;
  };
  networkAnalysis: {
    googleHitsDetected: number;
    hitsWithConsentSignal: number;
    gcsValues: string[];
    gcdPresent: boolean;
  };
  cookies: {
    totalBeforeConsent: number;
    firstParty: number;
    thirdParty: number;
    analyticsCookies: string[];
    adCookies: string[];
    analyticsCookiesBeforeConsent: boolean;
    adCookiesBeforeConsent: boolean;
  };
  categoryScores: Record<string, { score: number; max: number }>;
  issues: { severity: "high" | "medium" | "low" | "info"; category: string; message: string }[];
  recommendations: string[];
}

const ANALYTICS_COOKIE_PATTERNS = [
  /^_ga$/,
  /^_ga_[A-Z0-9]+$/i,
  /^_gid$/,
  /^_gat(_.*)?$/,
  /^__utm[a-z]$/,
];

const AD_COOKIE_PATTERNS = [
  /^IDE$/,
  /^DSID$/,
  /^_gcl_.*$/,
  /^_fbp$/,
  /^_fbc$/,
  /^test_cookie$/,
  /^fr$/i,
];

function matchesAny(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

export function analyzeConsent(
  raw: RawConsentData
): ConsentAnalysisResult {
  const params = raw.consentDefault.parameters;
  const hasAdStorage = typeof params.ad_storage === "string";
  const hasAnalyticsStorage = typeof params.analytics_storage === "string";
  const hasAdUserData = typeof params.ad_user_data === "string";
  const hasAdPersonalization = typeof params.ad_personalization === "string";
  const hasWaitForUpdate = typeof params.wait_for_update === "number";

  const v1Complete = hasAdStorage && hasAnalyticsStorage;
  const v2Complete = v1Complete && hasAdUserData && hasAdPersonalization;

  let consentVersion: "v1" | "v2" | null = null;
  if (raw.consentDefault.found) {
    consentVersion = v2Complete ? "v2" : v1Complete ? "v1" : null;
  }

  const categoryScores: Record<string, { score: number; max: number }> = {
    cmpPresent: {
      score: raw.cmp.detected ? 15 : 0,
      max: 15,
    },
    tcfApi: {
      score: raw.cmp.tcfApiPresent ? 10 : 0,
      max: 10,
    },
    consentDefault: {
      score:
        raw.consentDefault.found && raw.consentDefault.beforeGtm
          ? 20
          : raw.consentDefault.found
            ? 10
            : 0,
      max: 20,
    },
    consentV2Complete: {
      score: v2Complete ? 15 : v1Complete ? 7 : 0,
      max: 15,
    },
    waitForUpdate: {
      score: hasWaitForUpdate ? 5 : 0,
      max: 5,
    },
    consentInHits: {
      score: 15,
      max: 15,
    },
    noCookiesAnalytics: {
      score: 10,
      max: 10,
    },
    noCookiesAds: {
      score: 10,
      max: 10,
    },
  };

  const hitsWithConsentSignal = raw.googleHits.filter(
    (h) => h.gcs !== null || h.gcd !== null
  ).length;
  const gcsValues = Array.from(
    new Set(
      raw.googleHits
        .map((h) => h.gcs)
        .filter((v): v is string => v !== null)
    )
  );
  const gcdPresent = raw.googleHits.some((h) => h.gcd !== null);

  if (raw.googleHits.length > 0) {
    const ratio = hitsWithConsentSignal / raw.googleHits.length;
    categoryScores.consentInHits.score = Math.round(ratio * 15);
  } else {
    categoryScores.consentInHits.score = 15;
  }

  const firstPartyCookies = raw.cookies.filter((c) => c.firstParty);
  const thirdPartyCookies = raw.cookies.filter((c) => !c.firstParty);

  const analyticsCookies = raw.cookies
    .filter((c) => matchesAny(c.name, ANALYTICS_COOKIE_PATTERNS))
    .map((c) => c.name);
  const adCookies = raw.cookies
    .filter((c) => matchesAny(c.name, AD_COOKIE_PATTERNS))
    .map((c) => c.name);

  const analyticsCookiesBeforeConsent = analyticsCookies.length > 0;
  const adCookiesBeforeConsent = adCookies.length > 0;

  if (analyticsCookiesBeforeConsent) categoryScores.noCookiesAnalytics.score = 0;
  if (adCookiesBeforeConsent) categoryScores.noCookiesAds.score = 0;

  const score = Object.values(categoryScores).reduce(
    (s, c) => s + c.score,
    0
  );

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 90) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 50) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  const issues: ConsentAnalysisResult["issues"] = [];
  const recommendations: string[] = [];

  if (!raw.cmp.detected) {
    issues.push({
      severity: "high",
      category: "cmp",
      message:
        "No Consent Management Platform (CMP) detected — required for GDPR compliance in the EU",
    });
    recommendations.push(
      "Install a GDPR-compliant CMP (Cookiebot, OneTrust, Didomi, Axeptio, etc.) to collect user consent"
    );
  }

  if (!raw.cmp.tcfApiPresent && raw.cmp.detected) {
    issues.push({
      severity: "low",
      category: "cmp",
      message:
        "CMP detected but IAB TCF API (window.__tcfapi) not available — ad-tech vendors cannot read consent signals",
    });
  }

  if (!raw.consentDefault.found) {
    issues.push({
      severity: "high",
      category: "consentMode",
      message:
        "No gtag('consent', 'default', ...) call detected — Google Consent Mode is not configured",
    });
    recommendations.push(
      "Add gtag('consent', 'default', {...}) with denied values for ad_storage, analytics_storage, ad_user_data, ad_personalization before loading GTM/gtag"
    );
  } else {
    if (!raw.consentDefault.beforeGtm) {
      issues.push({
        severity: "high",
        category: "consentMode",
        message:
          "gtag('consent', 'default') is called AFTER GTM/gtag loads — the first hits leave without consent context",
      });
      recommendations.push(
        "Move gtag('consent', 'default', ...) before the GTM/gtag snippet"
      );
    }
    if (!v2Complete && v1Complete) {
      const missing: string[] = [];
      if (!hasAdUserData) missing.push("ad_user_data");
      if (!hasAdPersonalization) missing.push("ad_personalization");
      issues.push({
        severity: "high",
        category: "consentMode",
        message: `Consent Mode v2 is incomplete — missing: ${missing.join(", ")} (required for EEA traffic under DMA)`,
      });
      recommendations.push(
        `Add ${missing.join(" and ")} to your gtag('consent', 'default', ...) call`
      );
    }
    if (!v1Complete) {
      const missing: string[] = [];
      if (!hasAdStorage) missing.push("ad_storage");
      if (!hasAnalyticsStorage) missing.push("analytics_storage");
      issues.push({
        severity: "high",
        category: "consentMode",
        message: `Consent Mode default call is missing required parameters: ${missing.join(", ")}`,
      });
    }
    if (!hasWaitForUpdate) {
      issues.push({
        severity: "medium",
        category: "consentMode",
        message:
          "wait_for_update not configured — CMP consent update may not reach Google tags in time",
      });
      recommendations.push(
        "Configure wait_for_update in consent default to give the CMP time to load (e.g. 500ms)"
      );
    }
  }

  if (raw.googleHits.length > 0 && hitsWithConsentSignal < raw.googleHits.length) {
    const missing = raw.googleHits.length - hitsWithConsentSignal;
    issues.push({
      severity: "medium",
      category: "networkAnalysis",
      message: `${missing} of ${raw.googleHits.length} Google hit(s) do not carry a gcs/gcd consent signal`,
    });
  }

  if (analyticsCookiesBeforeConsent) {
    issues.push({
      severity: "high",
      category: "cookies",
      message: `Google Analytics cookies (${analyticsCookies.join(", ")}) set before user consent — potential GDPR violation`,
    });
    recommendations.push(
      "Ensure Google Analytics cookies are only set after analytics_storage is granted"
    );
  }
  if (adCookiesBeforeConsent) {
    issues.push({
      severity: "high",
      category: "cookies",
      message: `Advertising cookies (${adCookies.join(", ")}) set before user consent — potential GDPR violation`,
    });
    recommendations.push(
      "Ensure advertising cookies are only set after ad_storage is granted"
    );
  }

  return {
    score,
    grade,
    cmp: raw.cmp,
    consentMode: {
      detected: raw.consentDefault.found,
      version: consentVersion,
      defaultConsent: raw.consentDefault,
      updateConsent: raw.consentUpdate,
    },
    networkAnalysis: {
      googleHitsDetected: raw.googleHits.length,
      hitsWithConsentSignal,
      gcsValues,
      gcdPresent,
    },
    cookies: {
      totalBeforeConsent: raw.cookies.length,
      firstParty: firstPartyCookies.length,
      thirdParty: thirdPartyCookies.length,
      analyticsCookies,
      adCookies,
      analyticsCookiesBeforeConsent,
      adCookiesBeforeConsent,
    },
    categoryScores,
    issues,
    recommendations,
  };
}

// -------- Inline script consent parsing --------

interface ParsedConsentCall {
  type: "default" | "update";
  parameters: ConsentParameters;
  scriptIndex: number;
}

// Parse gtag('consent', 'default'|'update', { ... }) calls from inline scripts.
// Permissive: handles single/double quotes and trailing commas. Does not
// evaluate JS; uses regex to extract the object literal.
export function parseConsentCalls(
  scripts: { content: string; index: number }[]
): ParsedConsentCall[] {
  const calls: ParsedConsentCall[] = [];
  const pattern =
    /gtag\s*\(\s*['"]consent['"]\s*,\s*['"](default|update)['"]\s*,\s*(\{[\s\S]*?\})\s*\)/g;

  for (const { content, index } of scripts) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null = pattern.exec(content);
    while (match !== null) {
      const type = match[1] as "default" | "update";
      const objectLiteral = match[2];
      const parameters = parseConsentObject(objectLiteral);
      calls.push({ type, parameters, scriptIndex: index });
      match = pattern.exec(content);
    }
  }
  return calls;
}

// Permissive parser for the object literal passed to gtag('consent', ...)
function parseConsentObject(src: string): ConsentParameters {
  const out: ConsentParameters = {};
  const inner = src.slice(1, -1);
  const pairRe =
    /['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?\s*:\s*(['"][^'"]*['"]|\d+|true|false)/g;
  let match: RegExpExecArray | null = pairRe.exec(inner);
  while (match !== null) {
    const key = match[1];
    const rawValue = match[2];
    let value: string | number | boolean;
    if (rawValue.startsWith("'") || rawValue.startsWith('"')) {
      value = rawValue.slice(1, -1);
    } else if (rawValue === "true") {
      value = true;
    } else if (rawValue === "false") {
      value = false;
    } else {
      value = parseInt(rawValue, 10);
    }
    (out as Record<string, string | number | boolean>)[key] = value;
    match = pairRe.exec(inner);
  }
  return out;
}

// -------- Browser orchestration --------

interface ScriptInfo {
  src: string | null;
  content: string;
  index: number;
}

async function collectConsentData(
  url: string,
  wait_ms: number
): Promise<RawConsentData> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const googleHits: GoogleHit[] = [];

    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const reqUrl = request.url();
      if (
        reqUrl.includes("google-analytics.com/g/collect") ||
        reqUrl.includes("analytics.google.com/g/collect") ||
        reqUrl.includes("googletagmanager.com/gtag") ||
        reqUrl.includes("google.com/pagead") ||
        reqUrl.includes("googleadservices.com")
      ) {
        try {
          const parsed = new URL(reqUrl);
          googleHits.push({
            url: reqUrl,
            gcs: parsed.searchParams.get("gcs"),
            gcd: parsed.searchParams.get("gcd"),
          });
        } catch {
          /* ignore */
        }
      }
      request.continue();
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    const status = response?.status() ?? 0;

    if (wait_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait_ms));
    }

    const pageData = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;

      const scripts: Array<{
        src: string | null;
        content: string;
      }> = [];
      document.querySelectorAll("script").forEach((el) => {
        scripts.push({
          src: el.getAttribute("src"),
          content: el.textContent || "",
        });
      });

      const candidateGlobals = [
        "Cookiebot",
        "CookieConsent",
        "OneTrust",
        "OptanonWrapper",
        "Optanon",
        "Didomi",
        "didomiOnReady",
        "axeptioSDK",
        "_axcb",
        "cmplz_manage_consent",
        "cmplz_all_scripts_hook",
        "cookieyes",
        "UC_UI",
        "usercentrics",
        "_iub",
      ];
      const presentGlobals = candidateGlobals.filter(
        (name) => w[name] !== undefined
      );

      const tcfApiPresent = typeof w["__tcfapi"] === "function";

      let cmpVersion: string | null = null;
      const cb = w["Cookiebot"] as { version?: string } | undefined;
      if (cb && typeof cb === "object") {
        cmpVersion = cb.version ?? null;
      }

      const dataLayer = Array.isArray(w.dataLayer)
        ? (w.dataLayer as unknown[]).slice(0, 100)
        : [];

      return {
        scripts,
        presentGlobals,
        tcfApiPresent,
        cmpVersion,
        dataLayer,
      };
    });

    const rawCookies = await page.cookies();
    const pageDomain = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return "";
      }
    })();

    const cookies: CookieInfo[] = rawCookies.map((c) => {
      const cookieDomain = c.domain.replace(/^\./, "");
      const firstParty =
        pageDomain === cookieDomain ||
        pageDomain.endsWith("." + cookieDomain) ||
        cookieDomain.endsWith("." + pageDomain);
      return { name: c.name, domain: c.domain, firstParty };
    });

    const scriptUrls = pageData.scripts
      .map((s) => s.src)
      .filter((s): s is string => !!s);
    const vendorMatch = matchVendor(pageData.presentGlobals, scriptUrls);

    const cmp: CmpDetection = {
      detected: vendorMatch !== null || pageData.tcfApiPresent,
      vendor: vendorMatch?.vendor ?? null,
      version: pageData.cmpVersion,
      tcfApiPresent: pageData.tcfApiPresent,
      scriptUrl: vendorMatch?.scriptUrl ?? null,
    };

    const scriptInfos: ScriptInfo[] = pageData.scripts.map((s, idx) => ({
      src: s.src,
      content: s.content,
      index: idx,
    }));
    const gtmLoaderIndex = scriptInfos.findIndex(
      (s) =>
        s.src !== null &&
        (/googletagmanager\.com\/gtm\.js/.test(s.src) ||
          /googletagmanager\.com\/gtag\/js/.test(s.src))
    );

    const inlineScripts = scriptInfos.filter((s) => s.src === null);
    const parsedCalls = parseConsentCalls(inlineScripts);

    const defaultCall = parsedCalls.find((c) => c.type === "default");
    const updateCall = parsedCalls.find((c) => c.type === "update");

    const consentDefault: ConsentCallInfo = {
      found: defaultCall !== undefined,
      beforeGtm:
        defaultCall !== undefined &&
        (gtmLoaderIndex === -1 || defaultCall.scriptIndex < gtmLoaderIndex),
      parameters: defaultCall?.parameters ?? {},
    };
    const consentUpdate: ConsentCallInfo = {
      found: updateCall !== undefined,
      beforeGtm: false,
      parameters: updateCall?.parameters ?? {},
    };

    return {
      cmp,
      consentDefault,
      consentUpdate,
      googleHits,
      cookies,
      pageDomain,
      finalUrl: page.url(),
      status,
    };
  } finally {
    await browser.close();
  }
}

// -------- Main handler --------

export async function checkConsentMode({
  url,
  wait_ms,
}: {
  url: string;
  wait_ms: number;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  try {
    const raw = await withPuppeteerTimeout(
      () => collectConsentData(url, wait_ms),
      45000
    );
    const analysis = analyzeConsent(raw);

    const stdIssues = analysis.issues.map((i) =>
      createIssue(
        i.severity === "high"
          ? "error"
          : i.severity === "medium"
            ? "warning"
            : "info",
        i.category,
        i.message
      )
    );

    return {
      url,
      finalUrl: raw.finalUrl,
      status: raw.status,
      score: analysis.score,
      summary: `Audit Consent Mode de ${url}: score ${analysis.score}/100 (grade ${analysis.grade}${analysis.cmp.vendor ? `, CMP: ${analysis.cmp.vendor}` : ", no CMP"})`,
      issues: stdIssues,
      recommendations: analysis.recommendations,
      meta: createMeta(startTime, "puppeteer", false, false),
      data: {
        grade: analysis.grade,
        cmp: analysis.cmp,
        consentMode: analysis.consentMode,
        networkAnalysis: analysis.networkAnalysis,
        cookies: analysis.cookies,
        categoryScores: analysis.categoryScores,
        consentIssues: analysis.issues,
      },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown browser error";
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Impossible d'auditer ${url}: ${message}`,
      issues: [createIssue("error", "browser-error", message)],
      recommendations: [`[browser-error] ${message}`],
      meta: createMeta(startTime, "puppeteer", false, true),
      data: { error: message },
    };
  }
}
