import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  auditContentQuality,
  auditContentQualitySchema,
  computeReadability,
} from "../src/tools/audit-content-quality.js";

// -------- helpers --------

type RouteConfig = {
  body?: string;
  status?: number;
  headers?: Record<string, string>;
  url?: string;
  error?: Error;
};

function installFetchMock(routes: Record<string, RouteConfig>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const key = typeof input === "string" ? input : input.toString();
    const cfg = routes[key];
    if (!cfg) throw new Error(`No mock configured for ${key}`);
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

function lorem(totalWords: number, wordsPerSentence = 8): string {
  const vocab = [
    "quick",
    "brown",
    "fox",
    "jumps",
    "over",
    "the",
    "lazy",
    "dog",
    "every",
    "good",
    "day",
    "makes",
    "content",
    "clear",
    "simple",
    "short",
  ];
  const sentences: string[] = [];
  let emitted = 0;
  while (emitted < totalWords) {
    const len = Math.min(wordsPerSentence, totalWords - emitted);
    const words: string[] = [];
    for (let i = 0; i < len; i++) {
      words.push(vocab[(emitted + i) % vocab.length]);
    }
    const sentence = words.join(" ");
    sentences.push(sentence.charAt(0).toUpperCase() + sentence.slice(1));
    emitted += len;
  }
  return sentences.join(". ") + ".";
}

function loremParagraphs(count: number, wordsPerP: number): string {
  return Array.from({ length: count }, () => `<p>${lorem(wordsPerP)}</p>`).join(
    "\n"
  );
}

function longArticleHtml(lang = "en"): string {
  return `<!doctype html>
<html lang="${lang}">
<head><title>Long Article</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <h1>The Main Title of the Article</h1>
    <ul class="toc">
      <li><a href="#section-1">Section 1</a></li>
      <li><a href="#section-2">Section 2</a></li>
      <li><a href="#section-3">Section 3</a></li>
    </ul>
    <h2 id="section-1">First Section Heading</h2>
    ${loremParagraphs(4, 100)}
    <img src="/img1.jpg" alt="Illustration for section one">
    <h2 id="section-2">Second Section Heading</h2>
    ${loremParagraphs(4, 100)}
    <img src="/img2.jpg" alt="Diagram for section two">
    <h3>A subsection under section two</h3>
    ${loremParagraphs(3, 100)}
    <h2 id="section-3">Third Section Heading</h2>
    ${loremParagraphs(4, 100)}
    <p>
      Read more:
      <a href="/article-a">First related article</a>,
      <a href="/article-b">Second related article</a>,
      <a href="/article-c">Third related article</a>,
      <a href="https://example.org/external">External reference</a>,
      <a href="/article-d">Fourth related article</a>,
      <a href="/article-e">Fifth related article</a>.
    </p>
    <a href="/signup" class="btn-primary">Subscribe to our newsletter</a>
  </main>
  <footer>&copy; 2026</footer>
</body>
</html>`;
}

describe("computeReadability", () => {
  it("returns easy for short simple English sentences", () => {
    const r = computeReadability(
      "The dog runs fast. The cat sleeps on the mat. Birds sing at dawn.",
      "en"
    );
    expect(r.level).toBe("easy");
    expect(r.score).toBeGreaterThanOrEqual(60);
  });

  it("returns difficult for very long sentences", () => {
    const longSentence =
      "This is an extraordinarily complicated and unnecessarily verbose sentence constructed specifically to demonstrate that excessive length combined with polysyllabic terminology measurably degrades any automated readability assessment applied against the corpus.";
    const r = computeReadability(longSentence, "en");
    expect(r.level).toBe("difficult");
  });
});

describe("auditContentQuality (integration with mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  const targetUrl = "https://example.com/article";

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("scores a long, well-structured English article highly", async () => {
    installFetchMock({ [targetUrl]: { body: longArticleHtml("en") } });
    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    expect(result.status).toBe(200);
    expect(result.score).toBeGreaterThanOrEqual(80);
    const data = result.data as Record<string, any>;
    expect(["A", "B"]).toContain(data.grade);
    expect(data.metrics.wordCount).toBeGreaterThanOrEqual(1200);
    expect(data.metrics.headings.h1).toBe(1);
    expect(data.metrics.headings.hierarchyValid).toBe(true);
    expect(data.metrics.engagement.hasTOC).toBe(true);
    expect(data.metrics.engagement.hasCTA).toBe(true);
    expect(data.locale).toBe("en");
  });

  it("flags thin content on a page with less than 300 words", async () => {
    const html = `<!doctype html><html lang="en"><head><title>Thin</title></head>
      <body><main><h1>Short</h1><p>${lorem(80)}</p></main></body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.metrics.wordCount).toBeLessThan(300);
    expect(data.categoryScores.wordCountAndStructure.score).toBe(0);
    expect(
      data.contentIssues.some(
        (i: any) => i.category === "wordCount" && i.severity === "high"
      )
    ).toBe(true);
    expect(
      result.issues.some((i) => i.element === "thin-content")
    ).toBe(true);
  });

  it("penalizes a page with no H1", async () => {
    const html = `<!doctype html><html lang="en"><head><title>No H1</title></head>
      <body><main>
        <h2>Only a section heading</h2>
        <p>${lorem(400)}</p>
        <h2>Another section</h2>
        <p>${lorem(300)}</p>
      </main></body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.metrics.headings.h1).toBe(0);
    expect(data.categoryScores.headingStructure.score).toBeLessThan(15);
    expect(
      data.contentIssues.some(
        (i: any) => i.message.includes("H1") && i.severity === "high"
      )
    ).toBe(true);
  });

  it("flags broken heading hierarchy (H1 → H3 without H2)", async () => {
    const html = `<!doctype html><html lang="en"><head><title>Broken</title></head>
      <body><main>
        <h1>Title</h1>
        <h3>Subsection that skips H2</h3>
        <p>${lorem(500)}</p>
      </main></body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.metrics.headings.hierarchyValid).toBe(false);
    expect(
      data.contentIssues.some(
        (i: any) => i.message.includes("hierarchy") || i.message.includes("H2")
      )
    ).toBe(true);
  });

  it("auto-detects locale from the HTML lang attribute", async () => {
    const html = `<!doctype html><html lang="fr-BE"><head><title>Article</title></head>
      <body><main><h1>Titre</h1><p>${lorem(400)}</p></main></body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.locale).toBe("fr");
  });

  it("flags boilerplate-heavy pages with low text-to-HTML ratio", async () => {
    const divs = Array(500)
      .fill(
        '<div class="col-sm-12 container-fluid d-flex bg-primary-light some-utility"></div>'
      )
      .join("\n");
    const html = `<!doctype html><html lang="en"><head><title>Heavy</title></head>
      <body>
        ${divs}
        <main>
          <h1>Title</h1>
          <p>${lorem(350)}</p>
        </main>
        ${divs}
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.metrics.textToHtmlRatio).toBeLessThan(10);
    expect(data.categoryScores.contentUniqueness.score).toBe(0);
    expect(
      data.contentIssues.some(
        (i: any) =>
          i.category === "contentUniqueness" && i.severity === "high"
      )
    ).toBe(true);
    expect(
      result.issues.some((i) => i.element === "boilerplate-heavy")
    ).toBe(true);
  });

  it("detects FAQ from an H2 heading text", async () => {
    const html = `<!doctype html><html lang="en"><head><title>With FAQ</title></head>
      <body><main>
        <h1>Article about something</h1>
        <p>${lorem(350)}</p>
        <h2>FAQ</h2>
        <p>${lorem(100)}</p>
      </main></body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    const data = result.data as Record<string, any>;
    expect(data.metrics.engagement.hasFAQ).toBe(true);
    expect(data.categoryScores.engagementSignals.score).toBeGreaterThanOrEqual(2);
  });

  it("handles fetch timeout gracefully without crashing", async () => {
    installFetchMock({
      [targetUrl]: {
        error: Object.assign(new Error("The operation was aborted"), {
          name: "AbortError",
        }),
      },
    });

    const result = await auditContentQuality({
      url: targetUrl,
      locale: "auto",
      timeout: 10000,
    });

    expect(result.status).toBe(0);
    expect(result.score).toBe(0);
    expect(
      result.issues.some((i) => i.element === "fetch-error")
    ).toBe(true);
    expect((result.data as any).error).toMatch(/timed out/i);
  });

  it("validates input via the zod schema", () => {
    const schema = z.object(auditContentQualitySchema);
    expect(
      schema.safeParse({ url: "https://example.com" }).success
    ).toBe(true);
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", locale: "klingon" }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", timeout: 500 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", timeout: 20000 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", locale: "fr", timeout: 5000 })
        .success
    ).toBe(true);
  });
});
