import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  analyzeSecurityHeaders,
  checkSecurityHeaders,
  checkSecurityHeadersSchema,
} from "../src/tools/check-security-headers.js";

function mockFetchResponse(
  headers: Record<string, string>,
  opts: { url?: string; status?: number } = {}
): Response {
  const res = new Response("ok", {
    status: opts.status ?? 200,
    headers: new Headers(headers),
  });
  Object.defineProperty(res, "url", {
    value: opts.url ?? "https://example.com/",
    writable: false,
  });
  return res;
}

describe("analyzeSecurityHeaders (pure)", () => {
  it("returns grade A and score 100 when all headers are correctly set", () => {
    const headers = new Headers({
      "strict-transport-security":
        "max-age=31536000; includeSubDomains; preload",
      "content-security-policy": "default-src 'self'; script-src 'self'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "x-xss-protection": "1; mode=block",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "public, max-age=3600",
    });

    const result = analyzeSecurityHeaders(headers);

    expect(result.score).toBe(100);
    expect(result.grade).toBe("A");
    expect(result.critical_missing).toEqual([]);
    expect(result.headers["strict-transport-security"].status).toBe("pass");
    expect(result.headers["strict-transport-security"].details).toContain(
      "preload"
    );
    expect(result.headers["content-security-policy"].score).toBe(20);
  });

  it("returns grade F and lists critical missing headers when no security headers are set", () => {
    const result = analyzeSecurityHeaders(new Headers({}));

    expect(result.score).toBeLessThan(30);
    expect(result.grade).toBe("F");
    expect(result.critical_missing).toEqual(
      expect.arrayContaining([
        "strict-transport-security",
        "content-security-policy",
        "x-content-type-options",
      ])
    );
    expect(result.headers["content-security-policy"].status).toBe("fail");
    expect(result.headers["content-security-policy"].details).toMatch(/XSS/i);
  });

  it("flags CSP containing 'unsafe-inline' as warn with partial score", () => {
    const headers = new Headers({
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'",
    });
    const result = analyzeSecurityHeaders(headers);
    expect(result.headers["content-security-policy"].status).toBe("warn");
    expect(result.headers["content-security-policy"].score).toBe(10);
  });

  it("accepts CSP frame-ancestors as a substitute for X-Frame-Options", () => {
    const headers = new Headers({
      "content-security-policy": "frame-ancestors 'none'",
    });
    const result = analyzeSecurityHeaders(headers);
    expect(result.headers["x-frame-options"].status).toBe("pass");
    expect(result.headers["x-frame-options"].score).toBe(10);
  });

  it("warns when HSTS max-age is too short", () => {
    const headers = new Headers({
      "strict-transport-security": "max-age=3600",
    });
    const result = analyzeSecurityHeaders(headers);
    expect(result.headers["strict-transport-security"].status).toBe("warn");
    expect(result.headers["strict-transport-security"].score).toBe(7);
  });
});

describe("checkSecurityHeaders (integration with mocked fetch)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns a high score and grade A for an HTTPS URL with proper headers", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockFetchResponse(
        {
          "strict-transport-security":
            "max-age=31536000; includeSubDomains; preload",
          "content-security-policy": "default-src 'self'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "strict-origin-when-cross-origin",
          "permissions-policy":
            "camera=(), microphone=(), geolocation=()",
          "x-xss-protection": "1; mode=block",
          "cross-origin-opener-policy": "same-origin",
          "cross-origin-resource-policy": "same-origin",
          "cross-origin-embedder-policy": "require-corp",
          "cache-control": "public, max-age=3600",
          server: "nginx/1.24.0",
        },
        { url: "https://secure.example.com/" }
      )
    ) as typeof fetch;

    const result = await checkSecurityHeaders({
      url: "https://secure.example.com/",
    });

    expect(result.status).toBe(200);
    expect(result.score).toBe(100);
    const data = result.data as Record<string, unknown>;
    expect(data.grade).toBe("A");
    expect(data.tls).toBe(true);
    expect(data.server).toBe("nginx/1.24.0");
    expect(data.critical_missing).toEqual([]);
  });

  it("returns a very low score for a URL without any security headers", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockFetchResponse({}, { url: "https://example.com/" })
    ) as typeof fetch;

    const result = await checkSecurityHeaders({
      url: "https://example.com/",
    });

    expect(result.status).toBe(200);
    expect(result.score).toBeLessThan(30);
    const data = result.data as Record<string, unknown>;
    expect(data.grade).toBe("F");
    expect(data.critical_missing).toEqual(
      expect.arrayContaining([
        "strict-transport-security",
        "content-security-policy",
        "x-content-type-options",
      ])
    );
    // recommendations array should contain high-severity entries
    const recs = data.recommendations as Array<{ severity: string }>;
    expect(recs.some((r) => r.severity === "high")).toBe(true);
  });

  it("flags TLS issue for an HTTP URL and marks HSTS as missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      mockFetchResponse(
        {
          "content-security-policy": "default-src 'self'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        },
        { url: "http://insecure.example.com/" }
      )
    ) as typeof fetch;

    const result = await checkSecurityHeaders({
      url: "http://insecure.example.com/",
    });

    const data = result.data as Record<string, unknown>;
    expect(data.tls).toBe(false);
    const headers = data.headers as Record<string, { present: boolean }>;
    expect(headers["strict-transport-security"].present).toBe(false);
    expect(result.issues.some((i) => i.element === "tls")).toBe(true);
  });

  it("returns an error response when fetch times out (AbortError)", async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }) as typeof fetch;

    const result = await checkSecurityHeaders({
      url: "https://timeout.test/",
    });

    expect(result.status).toBe(0);
    expect(result.score).toBe(0);
    expect(result.issues.some((i) => i.element === "fetch-error")).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.error).toMatch(/timed out/i);
  });

  it("validates the input URL via the zod schema", () => {
    const schema = z.object(checkSecurityHeadersSchema);

    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });
});
