import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import {
  checkAccessibility,
  checkAccessibilitySchema,
} from "../src/tools/check-accessibility.js";

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

const targetUrl = "https://example.com/page";

const goodPageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Accessible Page</title>
</head>
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <header>
    <nav aria-label="Primary">
      <ul>
        <li><a href="/">Home</a></li>
        <li><a href="/about">About us</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </nav>
  </header>
  <main id="main-content">
    <h1>Welcome to the accessible page</h1>
    <p>Intro paragraph with <a href="/learn">descriptive link to the learning section</a>.</p>

    <h2>Our services</h2>
    <p>Here is a meaningful description of what we offer to visitors of the site.</p>
    <img src="/hero.jpg" alt="Team of engineers reviewing accessibility reports">

    <h2>Contact form</h2>
    <form>
      <label for="name">Your name</label>
      <input id="name" name="name" type="text" required>

      <label for="email">Email address</label>
      <input id="email" name="email" type="email" required>

      <label for="message">Message</label>
      <textarea id="message" name="message"></textarea>

      <button type="submit">Send message</button>
    </form>
  </main>
  <footer>
    <p>&copy; 2026 Example Inc.</p>
  </footer>
</body>
</html>`;

describe("checkAccessibility", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("scores a well-accessible page highly", async () => {
    installFetchMock({ [targetUrl]: { body: goodPageHtml } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    expect(result.status).toBe(200);
    expect(result.score).toBeGreaterThanOrEqual(85);
    const data = result.data as Record<string, any>;
    expect(["A", "B"]).toContain(data.grade);
    expect(data.summary.critical).toBe(0);
    expect(data.categoryScores.semanticStructure.score).toBeGreaterThanOrEqual(
      12
    );
    expect(data.categoryScores.forms.score).toBe(15);
  });

  it("flags images without alt attributes as critical", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">Home</a></nav></header>
        <main>
          <h1>Page</h1>
          <img src="/one.jpg">
          <img src="/two.jpg">
          <p>Some meaningful content here that describes the images above.</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    const imageIssues = data.issues.filter(
      (i: any) => i.category === "images"
    );
    expect(imageIssues.length).toBeGreaterThanOrEqual(2);
    expect(
      imageIssues.every((i: any) => i.severity === "critical")
    ).toBe(true);
    expect(imageIssues[0].wcag).toBe("1.1.1");
    expect(imageIssues[0].selector).toContain("img");
    expect(data.categoryScores.images.score).toBeLessThan(15);
  });

  it("flags form fields without accessible labels", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main>
          <h1>Form</h1>
          <form>
            <input type="text" name="name">
            <input type="email" name="email">
            <select name="country"><option>FR</option></select>
          </form>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    const formIssues = data.issues.filter((i: any) => i.category === "forms");
    expect(formIssues.length).toBe(3);
    expect(formIssues.every((i: any) => i.severity === "critical")).toBe(true);
    expect(formIssues[0].wcag).toBe("3.3.2");
    expect(data.categoryScores.forms.score).toBe(0);
  });

  it("flags missing <main> landmark", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <div><h1>No main here</h1><p>content</p></div>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    expect(
      data.issues.some(
        (i: any) =>
          i.category === "semanticStructure" &&
          i.message.includes("main") &&
          i.severity === "major"
      )
    ).toBe(true);
    expect(data.categoryScores.semanticStructure.score).toBeLessThan(15);
  });

  it("flags missing lang attribute on <html>", async () => {
    const html = `<!doctype html><html><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main><h1>Hi</h1><p>text</p></main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    expect(
      data.issues.some(
        (i: any) =>
          i.wcag === "3.1.1" &&
          i.severity === "critical" &&
          i.message.includes("lang")
      )
    ).toBe(true);
  });

  it("flags generic link text like 'click here'", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">Home</a></nav></header>
        <main>
          <h1>Article</h1>
          <p>For more info, <a href="/info">click here</a>.</p>
          <p>Additional context: <a href="/about">read more</a>.</p>
          <p>Good link: <a href="/pricing">View our pricing plans</a>.</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    const linkIssues = data.issues.filter(
      (i: any) => i.category === "links" && i.message.includes("generic")
    );
    expect(linkIssues.length).toBeGreaterThanOrEqual(2);
    expect(linkIssues[0].wcag).toBe("2.4.4");
    expect(linkIssues[0].severity).toBe("major");
  });

  it("flags broken heading hierarchy (H1 → H3)", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main>
          <h1>Title</h1>
          <h3>Subsection that skips H2</h3>
          <p>Content here.</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    expect(
      data.issues.some(
        (i: any) =>
          i.category === "headingHierarchy" &&
          i.message.includes("skips") &&
          i.severity === "major"
      )
    ).toBe(true);
    expect(data.categoryScores.headingHierarchy.score).toBeLessThan(10);
  });

  it("flags viewport with user-scalable=no", async () => {
    const html = `<!doctype html><html lang="en">
      <head>
        <title>t</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
      </head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main><h1>Hi</h1><p>c</p></main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    expect(
      data.issues.some(
        (i: any) =>
          i.category === "contrastAndVisuals" &&
          i.message.includes("zoom") &&
          i.severity === "critical"
      )
    ).toBe(true);
    expect(data.categoryScores.contrastAndVisuals.score).toBeLessThan(10);
  });

  it("flags invalid ARIA roles and broken aria-labelledby references", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main>
          <h1>Page</h1>
          <div role="banana">Invalid role</div>
          <div aria-labelledby="nonexistent">Broken reference</div>
          <nav role="navigation" aria-label="Redundant">
            <a href="/x">x</a>
          </nav>
          <p>content</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    const ariaIssues = data.issues.filter(
      (i: any) => i.category === "ariaUsage"
    );
    expect(
      ariaIssues.some((i: any) => i.message.includes("Invalid ARIA role"))
    ).toBe(true);
    expect(
      ariaIssues.some((i: any) =>
        i.message.includes("aria-labelledby references missing")
      )
    ).toBe(true);
    expect(
      ariaIssues.some((i: any) => i.message.includes("Redundant"))
    ).toBe(true);
    expect(data.categoryScores.ariaUsage.score).toBeLessThan(10);
  });

  it("flags iframe without title attribute", async () => {
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main>
          <h1>Embed</h1>
          <iframe src="https://example.org/embed"></iframe>
          <p>context</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    const data = result.data as Record<string, any>;
    expect(
      data.issues.some(
        (i: any) =>
          i.category === "media" &&
          i.message.includes("iframe") &&
          i.wcag === "4.1.2"
      )
    ).toBe(true);
    expect(data.categoryScores.media.score).toBeLessThan(5);
  });

  it("handles fetch timeout gracefully", async () => {
    installFetchMock({
      [targetUrl]: {
        error: Object.assign(new Error("aborted"), { name: "AbortError" }),
      },
    });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });

    expect(result.status).toBe(0);
    expect(result.score).toBe(0);
    expect(result.issues.some((i) => i.element === "fetch-error")).toBe(true);
    expect((result.data as any).error).toMatch(/timed out/i);
  });

  it("validates input via the zod schema", () => {
    const schema = z.object(checkAccessibilitySchema);
    expect(schema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(schema.safeParse({ url: "not-a-url" }).success).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", timeout: 500 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", timeout: 20000 }).success
    ).toBe(false);
    expect(
      schema.safeParse({ url: "https://e.com", timeout: 8000 }).success
    ).toBe(true);
  });

  it("truncates element snippets to 120 characters", async () => {
    const longAttrs = 'data-x="' + "x".repeat(200) + '"';
    const html = `<!doctype html><html lang="en"><head><title>t</title></head>
      <body>
        <header><nav><a href="/">h</a></nav></header>
        <main>
          <h1>Page</h1>
          <img src="/a.jpg" ${longAttrs}>
          <p>content</p>
        </main>
        <footer>f</footer>
      </body></html>`;
    installFetchMock({ [targetUrl]: { body: html } });

    const result = await checkAccessibility({ url: targetUrl, timeout: 10000 });
    const data = result.data as Record<string, any>;
    const imgIssue = data.issues.find((i: any) => i.category === "images");
    expect(imgIssue).toBeDefined();
    expect(imgIssue.element.length).toBeLessThanOrEqual(120);
  });
});
