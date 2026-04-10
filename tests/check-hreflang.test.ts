import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  checkHreflang,
  checkHreflangSchema,
  isValidHreflangCode,
  parseLinkHeader,
} from "../src/tools/check-hreflang.js";

type RouteConfig = {
  body?: string;
  status?: number;
  headers?: Record<string, string>;
  url?: string;
  error?: Error;
};

function makeHtml(
  hreflangs: Array<{ hreflang: string; href: string }>,
  canonical?: string
): string {
  const links = hreflangs
    .map(
      (h) =>
        `<link rel="alternate" hreflang="${h.hreflang}" href="${h.href}">`
    )
    .join("\n    ");
  const can = canonical
    ? `<link rel="canonical" href="${canonical}">`
    : "";
  return `<!doctype html><html><head>
    ${links}
    ${can}
  </head><body></body></html>`;
}

function installFetchMock(routes: Record<string, RouteConfig>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const key = typeof input === "string" ? input : input.toString();
    const cfg = routes[key];
    if (!cfg) {
      throw new Error(`No mock configured for ${key}`);
    }
    if (cfg.error) throw cfg.error;
    const res = new Response(cfg.body ?? "", {
      status: cfg.status ?? 200,
      headers: new Headers(cfg.headers ?? { "content-type": "text/html" }),
    });
    Object.defineProperty(res, "url", {
      value: cfg.url ?? key,
      writable: false,
    });
    return res;
  }) as unknown as typeof fetch;
}

describe("helpers", () => {
  it("validates ISO 639-1 hreflang codes", () => {
    expect(isValidHreflangCode("fr")).toBe(true);
    expect(isValidHreflangCode("en")).toBe(true);
    expect(isValidHreflangCode("fr-BE")).toBe(true);
    expect(isValidHreflangCode("en-US")).toBe(true);
    expect(isValidHreflangCode("x-default")).toBe(true);
    expect(isValidHreflangCode("french")).toBe(false);
    expect(isValidHreflangCode("FRE")).toBe(false);
    expect(isValidHreflangCode("fr_BE")).toBe(false);
  });

  it("parses Link header hreflang entries", () => {
    const header =
      '<https://example.com/en/>; rel="alternate"; hreflang="en", <https://example.com/fr/>; rel="alternate"; hreflang="fr"';
    const parsed = parseLinkHeader(header);
    expect(parsed).toEqual([
      { hreflang: "en", href: "https://example.com/en/" },
      { hreflang: "fr", href: "https://example.com/fr/" },
    ]);
  });
});

describe("checkHreflang (integration with mocked fetch)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const frUrl = "https://example.com/fr/";
  const enUrl = "https://example.com/en/";
  const rootUrl = "https://example.com/";

  it("scores high when hreflang is complete with full reciprocity", async () => {
    const fullCluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
      { hreflang: "x-default", href: rootUrl },
    ];
    installFetchMock({
      [frUrl]: { body: makeHtml(fullCluster, frUrl) },
      [enUrl]: { body: makeHtml(fullCluster, enUrl) },
      [rootUrl]: { body: makeHtml(fullCluster, rootUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    expect(result.status).toBe(200);
    expect(result.score).toBeGreaterThanOrEqual(90);
    const data = result.data as Record<string, any>;
    expect(data.grade).toBe("A");
    expect(data.summary.hasXDefault).toBe(true);
    expect(data.summary.hasSelfReference).toBe(true);
    expect(data.summary.reciprocalCount).toBe(3);
    expect(data.summary.languageConsistency).toBe(true);
    expect(data.summary.canonicalConflicts).toBe(0);
    expect(data.source).toBe("html-head");
  });

  it("returns score 0 and no-hreflang issue when the page has no hreflang", async () => {
    installFetchMock({
      [frUrl]: {
        body: "<!doctype html><html><head><title>plain</title></head><body></body></html>",
      },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    expect(result.score).toBe(0);
    const data = result.data as Record<string, any>;
    expect(data.grade).toBe("F");
    expect(data.source).toBe("none");
    expect(
      result.issues.some((i) => i.element === "no-hreflang")
    ).toBe(true);
  });

  it("flags invalid language codes", async () => {
    installFetchMock({
      [frUrl]: {
        body: makeHtml(
          [
            { hreflang: "french", href: frUrl },
            { hreflang: "english", href: enUrl },
            { hreflang: "x-default", href: rootUrl },
          ],
          frUrl
        ),
      },
      [enUrl]: {
        body: makeHtml(
          [
            { hreflang: "french", href: frUrl },
            { hreflang: "english", href: enUrl },
            { hreflang: "x-default", href: rootUrl },
          ],
          enUrl
        ),
      },
      [rootUrl]: {
        body: makeHtml(
          [
            { hreflang: "french", href: frUrl },
            { hreflang: "english", href: enUrl },
            { hreflang: "x-default", href: rootUrl },
          ],
          rootUrl
        ),
      },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    expect(data.summary.invalidLanguageCodes).toBe(2);
    expect(
      data.hreflangIssues.some((i: any) => i.type === "invalid-language-code")
    ).toBe(true);
    // invalid codes partially penalize validCodes dimension (2/3 * 15 lost)
    expect(result.score).toBeLessThan(100);
  });

  it("marks a 404 alternate as inaccessible", async () => {
    const cluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
      { hreflang: "x-default", href: rootUrl },
    ];
    installFetchMock({
      [frUrl]: { body: makeHtml(cluster, frUrl) },
      [enUrl]: { status: 404, body: "Not found" },
      [rootUrl]: { body: makeHtml(cluster, rootUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    const enTag = data.hreflangTags.find((t: any) => t.hreflang === "en");
    expect(enTag.status).toBe(404);
    expect(
      data.hreflangIssues.some(
        (i: any) => i.type === "inaccessible-alternate" && i.hreflang === "en"
      )
    ).toBe(true);
    expect(data.summary.inaccessibleUrls).toBeGreaterThanOrEqual(1);
  });

  it("detects missing reciprocal linking", async () => {
    const sourceCluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
      { hreflang: "x-default", href: rootUrl },
    ];
    installFetchMock({
      [frUrl]: { body: makeHtml(sourceCluster, frUrl) },
      // /en/ declares nothing pointing back to /fr/
      [enUrl]: {
        body: "<!doctype html><html><head></head><body></body></html>",
      },
      [rootUrl]: { body: makeHtml(sourceCluster, rootUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    const enTag = data.hreflangTags.find((t: any) => t.hreflang === "en");
    expect(enTag.reciprocal).toBe(false);
    expect(
      data.hreflangIssues.some(
        (i: any) => i.type === "missing-reciprocal" && i.hreflang === "en"
      )
    ).toBe(true);
  });

  it("flags canonical conflict when source canonical points outside the cluster", async () => {
    const cluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
      { hreflang: "x-default", href: rootUrl },
    ];
    installFetchMock({
      [frUrl]: {
        body: makeHtml(cluster, "https://example.com/master"),
      },
      [enUrl]: { body: makeHtml(cluster, enUrl) },
      [rootUrl]: { body: makeHtml(cluster, rootUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    expect(data.summary.canonicalConflicts).toBeGreaterThanOrEqual(1);
    expect(
      data.hreflangIssues.some((i: any) => i.type === "canonical-conflict")
    ).toBe(true);
  });

  it("warns when x-default is missing", async () => {
    const cluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
    ];
    installFetchMock({
      [frUrl]: { body: makeHtml(cluster, frUrl) },
      [enUrl]: { body: makeHtml(cluster, enUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    expect(data.summary.hasXDefault).toBe(false);
    expect(
      data.hreflangIssues.some((i: any) => i.type === "missing-x-default")
    ).toBe(true);
  });

  it("parses hreflang from HTTP Link header when not present in HTML", async () => {
    const linkHeader =
      `<${frUrl}>; rel="alternate"; hreflang="fr", ` +
      `<${enUrl}>; rel="alternate"; hreflang="en", ` +
      `<${rootUrl}>; rel="alternate"; hreflang="x-default"`;

    installFetchMock({
      [frUrl]: {
        body: "<!doctype html><html><head></head><body></body></html>",
        headers: { "content-type": "text/html", link: linkHeader },
      },
      [enUrl]: {
        body: "<!doctype html><html><head></head><body></body></html>",
        headers: { "content-type": "text/html", link: linkHeader },
      },
      [rootUrl]: {
        body: "<!doctype html><html><head></head><body></body></html>",
        headers: { "content-type": "text/html", link: linkHeader },
      },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    const data = result.data as Record<string, any>;
    expect(data.source).toBe("http-header");
    expect(data.summary.totalAlternates).toBe(3);
    expect(data.summary.reciprocalCount).toBe(3);
  });

  it("validates input via the zod schema", () => {
    const schema = z.object(checkHreflangSchema);
    expect(
      schema.safeParse({ url: "https://example.com" }).success
    ).toBe(true);
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ url: "https://example.com", timeout: 500 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://example.com", timeout: 20000 }).success
    ).toBe(false);
  });

  it("handles alternate timeouts gracefully without crashing", async () => {
    const cluster = [
      { hreflang: "fr", href: frUrl },
      { hreflang: "en", href: enUrl },
      { hreflang: "x-default", href: rootUrl },
    ];
    installFetchMock({
      [frUrl]: { body: makeHtml(cluster, frUrl) },
      [enUrl]: {
        error: Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      },
      [rootUrl]: { body: makeHtml(cluster, rootUrl) },
    });

    const result = await checkHreflang({
      url: frUrl,
      followAlternates: true,
      timeout: 8000,
    });

    // Must not throw; en alternate reported as inaccessible (status 0)
    const data = result.data as Record<string, any>;
    const enTag = data.hreflangTags.find((t: any) => t.hreflang === "en");
    expect(enTag.status).toBe(0);
    expect(
      data.hreflangIssues.some(
        (i: any) => i.type === "inaccessible-alternate" && i.hreflang === "en"
      )
    ).toBe(true);
    // Other alternates still analyzed
    const frTag = data.hreflangTags.find((t: any) => t.hreflang === "fr");
    expect(frTag.isSelf).toBe(true);
  });
});
