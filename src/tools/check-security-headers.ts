import { z } from "zod";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkSecurityHeadersSchema = {
  url: z.string().url().describe("The URL to audit for security headers"),
};

type HeaderStatus = "pass" | "warn" | "fail";

interface HeaderResult {
  present: boolean;
  value: string | null;
  score: number;
  maxScore: number;
  status: HeaderStatus;
  details: string;
}

interface StructuredRecommendation {
  severity: "high" | "medium" | "low";
  header: string;
  message: string;
}

export interface SecurityHeadersAnalysis {
  headers: Record<string, HeaderResult>;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  critical_missing: string[];
}

const SAFE_REFERRER_POLICIES = new Set([
  "no-referrer",
  "strict-origin",
  "same-origin",
  "strict-origin-when-cross-origin",
]);

const CRITICAL_HEADERS = [
  "strict-transport-security",
  "content-security-policy",
  "x-content-type-options",
];

function analyzeHsts(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 15,
      status: "fail",
      details: "Missing Strict-Transport-Security header",
    };
  }

  const maxAgeMatch = value.match(/max-age\s*=\s*(\d+)/i);
  const maxAge = maxAgeMatch ? parseInt(maxAgeMatch[1], 10) : 0;
  const hasIncludeSubdomains = /includeSubDomains/i.test(value);
  const hasPreload = /preload/i.test(value);

  if (maxAge < 31536000) {
    return {
      present: true,
      value,
      score: 7,
      maxScore: 15,
      status: "warn",
      details: `HSTS max-age too short (${maxAge}s, recommended >= 31536000)`,
    };
  }

  let score = 13;
  const extras: string[] = [];
  if (hasIncludeSubdomains) {
    score += 1;
    extras.push("includeSubDomains");
  }
  if (hasPreload) {
    score += 1;
    extras.push("preload");
  }

  return {
    present: true,
    value,
    score,
    maxScore: 15,
    status: "pass",
    details: extras.length
      ? `HSTS enabled with ${extras.join(", ")}`
      : "HSTS enabled",
  };
}

function analyzeCsp(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 20,
      status: "fail",
      details: "Missing CSP header — high risk of XSS",
    };
  }

  const lowered = value.toLowerCase();
  const scriptSrcMatch = lowered.match(/script-src[^;]*/);
  const defaultSrcMatch = lowered.match(/default-src[^;]*/);
  const target = scriptSrcMatch?.[0] ?? defaultSrcMatch?.[0] ?? "";
  const hasUnsafeInline = target.includes("'unsafe-inline'");
  const hasUnsafeEval = target.includes("'unsafe-eval'");

  if (hasUnsafeInline || hasUnsafeEval) {
    const unsafes: string[] = [];
    if (hasUnsafeInline) unsafes.push("'unsafe-inline'");
    if (hasUnsafeEval) unsafes.push("'unsafe-eval'");
    return {
      present: true,
      value,
      score: 10,
      maxScore: 20,
      status: "warn",
      details: `CSP present but contains ${unsafes.join(" and ")} in script-src`,
    };
  }

  return {
    present: true,
    value,
    score: 20,
    maxScore: 20,
    status: "pass",
    details: "CSP present with strict script-src",
  };
}

function analyzeXContentTypeOptions(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 10,
      status: "fail",
      details: "Missing X-Content-Type-Options header",
    };
  }
  if (value.trim().toLowerCase() !== "nosniff") {
    return {
      present: true,
      value,
      score: 0,
      maxScore: 10,
      status: "fail",
      details: `X-Content-Type-Options must be exactly "nosniff" (got "${value}")`,
    };
  }
  return {
    present: true,
    value,
    score: 10,
    maxScore: 10,
    status: "pass",
    details: "X-Content-Type-Options set to nosniff",
  };
}

function analyzeXFrameOptions(
  value: string | null,
  csp: string | null
): HeaderResult {
  const cspHasFrameAncestors = csp !== null && /frame-ancestors/i.test(csp);

  if (cspHasFrameAncestors && !value) {
    return {
      present: false,
      value: null,
      score: 10,
      maxScore: 10,
      status: "pass",
      details:
        "frame-ancestors directive defined in CSP (X-Frame-Options superseded)",
    };
  }

  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 10,
      status: "fail",
      details: "Missing X-Frame-Options header",
    };
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === "DENY" || normalized === "SAMEORIGIN") {
    return {
      present: true,
      value,
      score: 10,
      maxScore: 10,
      status: "pass",
      details: `X-Frame-Options set to ${normalized}`,
    };
  }

  return {
    present: true,
    value,
    score: 0,
    maxScore: 10,
    status: "fail",
    details: `X-Frame-Options has unexpected value "${value}" (expected DENY or SAMEORIGIN)`,
  };
}

function analyzeReferrerPolicy(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 10,
      status: "fail",
      details: "Missing Referrer-Policy header",
    };
  }
  const policies = value
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const hasSafe = policies.some((p) => SAFE_REFERRER_POLICIES.has(p));
  if (hasSafe) {
    return {
      present: true,
      value,
      score: 10,
      maxScore: 10,
      status: "pass",
      details: `Referrer-Policy uses safe value (${value})`,
    };
  }
  return {
    present: true,
    value,
    score: 5,
    maxScore: 10,
    status: "warn",
    details: `Referrer-Policy uses weaker value "${value}" — prefer strict-origin-when-cross-origin`,
  };
}

function analyzePermissionsPolicy(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 10,
      status: "fail",
      details: "Missing Permissions-Policy header",
    };
  }
  const sensitive = ["camera", "microphone", "geolocation"];
  const lowered = value.toLowerCase();
  const missing = sensitive.filter((feat) => {
    const regex = new RegExp(`${feat}\\s*=\\s*\\([^)]*\\)`, "i");
    return !regex.test(lowered);
  });

  if (missing.length === 0) {
    return {
      present: true,
      value,
      score: 10,
      maxScore: 10,
      status: "pass",
      details:
        "Permissions-Policy restricts camera, microphone, and geolocation",
    };
  }
  return {
    present: true,
    value,
    score: 5,
    maxScore: 10,
    status: "warn",
    details: `Permissions-Policy present but does not restrict: ${missing.join(", ")}`,
  };
}

function analyzeXssProtection(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 5,
      status: "warn",
      details:
        "Missing X-XSS-Protection header (deprecated but still expected by some scanners)",
    };
  }
  return {
    present: true,
    value,
    score: 5,
    maxScore: 5,
    status: "pass",
    details: "X-XSS-Protection present",
  };
}

function analyzeSimplePresence(
  name: string,
  value: string | null,
  maxScore: number
): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore,
      status: "warn",
      details: `Missing ${name} header`,
    };
  }
  return {
    present: true,
    value,
    score: maxScore,
    maxScore,
    status: "pass",
    details: `${name} present`,
  };
}

function analyzeCacheControl(value: string | null): HeaderResult {
  if (!value) {
    return {
      present: false,
      value: null,
      score: 0,
      maxScore: 5,
      status: "warn",
      details: "Missing Cache-Control header",
    };
  }
  return {
    present: true,
    value,
    score: 5,
    maxScore: 5,
    status: "pass",
    details: `Cache-Control set: ${value}`,
  };
}

export function analyzeSecurityHeaders(
  headers: Headers
): SecurityHeadersAnalysis {
  const cspValue = headers.get("content-security-policy");

  const results: Record<string, HeaderResult> = {
    "strict-transport-security": analyzeHsts(
      headers.get("strict-transport-security")
    ),
    "content-security-policy": analyzeCsp(cspValue),
    "x-content-type-options": analyzeXContentTypeOptions(
      headers.get("x-content-type-options")
    ),
    "x-frame-options": analyzeXFrameOptions(
      headers.get("x-frame-options"),
      cspValue
    ),
    "referrer-policy": analyzeReferrerPolicy(headers.get("referrer-policy")),
    "permissions-policy": analyzePermissionsPolicy(
      headers.get("permissions-policy")
    ),
    "x-xss-protection": analyzeXssProtection(headers.get("x-xss-protection")),
    "cross-origin-opener-policy": analyzeSimplePresence(
      "Cross-Origin-Opener-Policy",
      headers.get("cross-origin-opener-policy"),
      5
    ),
    "cross-origin-resource-policy": analyzeSimplePresence(
      "Cross-Origin-Resource-Policy",
      headers.get("cross-origin-resource-policy"),
      5
    ),
    "cross-origin-embedder-policy": analyzeSimplePresence(
      "Cross-Origin-Embedder-Policy",
      headers.get("cross-origin-embedder-policy"),
      5
    ),
    "cache-control": analyzeCacheControl(headers.get("cache-control")),
  };

  const totalScore = Object.values(results).reduce(
    (sum, r) => sum + r.score,
    0
  );
  const maxTotal = Object.values(results).reduce(
    (sum, r) => sum + r.maxScore,
    0
  );
  const score = Math.round((totalScore / maxTotal) * 100);

  let grade: "A" | "B" | "C" | "D" | "F";
  if (score >= 90) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 50) grade = "C";
  else if (score >= 30) grade = "D";
  else grade = "F";

  const critical_missing = CRITICAL_HEADERS.filter(
    (k) => results[k].status === "fail" && !results[k].present
  );

  return {
    headers: results,
    score,
    grade,
    critical_missing,
  };
}

export async function checkSecurityHeaders({
  url,
}: {
  url: string;
}): Promise<StandardResponse> {
  const startTime = performance.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const message = isAbort
      ? "Request timed out after 10s"
      : err instanceof Error
        ? err.message
        : "Unknown fetch error";
    return {
      url,
      finalUrl: url,
      status: 0,
      score: 0,
      summary: `Impossible de récupérer ${url}: ${message}`,
      issues: [createIssue("error", "fetch-error", message)],
      recommendations: [`[fetch-error] ${message}`],
      meta: createMeta(startTime, "fetch", false, true),
      data: {
        error: message,
      },
    };
  }
  clearTimeout(timeoutId);

  const analysis = analyzeSecurityHeaders(response.headers);
  const finalUrl = response.url || url;
  const server = response.headers.get("server");

  let tls = false;
  try {
    tls = new URL(finalUrl).protocol === "https:";
  } catch {
    tls = false;
  }

  const issues = [];
  const structuredRecommendations: StructuredRecommendation[] = [];

  for (const [name, result] of Object.entries(analysis.headers)) {
    if (result.status === "fail") {
      const isCritical = CRITICAL_HEADERS.includes(name);
      issues.push(
        createIssue("error", name, result.details, result.value ?? undefined)
      );
      structuredRecommendations.push({
        severity: isCritical ? "high" : "medium",
        header: name,
        message: `Add a ${name} header. ${result.details}`,
      });
    } else if (result.status === "warn") {
      const maxIsFive = result.maxScore === 5;
      issues.push(
        createIssue("warning", name, result.details, result.value ?? undefined)
      );
      structuredRecommendations.push({
        severity: maxIsFive ? "low" : "medium",
        header: name,
        message: `Improve ${name}: ${result.details}`,
      });
    }
  }

  if (!tls) {
    issues.push(
      createIssue(
        "error",
        "tls",
        "Connection is not using HTTPS — security headers cannot enforce transport security",
        finalUrl
      )
    );
  }

  return {
    url,
    finalUrl,
    status: response.status,
    score: analysis.score,
    summary: `Audit des security headers de ${url}: score ${analysis.score}/100 (grade ${analysis.grade})`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      grade: analysis.grade,
      headers: analysis.headers,
      critical_missing: analysis.critical_missing,
      recommendations: structuredRecommendations,
      server,
      tls,
    },
  };
}
