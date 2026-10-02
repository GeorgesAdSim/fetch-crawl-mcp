/**
 * Real Chromium: checks that pages from launchBrowser() cannot reach
 * internal addresses, including via sub-resources and redirects.
 * Skipped automatically when no Chromium is available.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequestChecker, launchBrowser } from "../src/utils/browser.js";

describe("createRequestChecker", () => {
  it("allows data:/blob:, blocks internal URLs, caches per host", async () => {
    let lookups = 0;
    const check = createRequestChecker(async (url) => {
      lookups++;
      if (url.includes("evil")) throw new Error("x");
    });
    expect(await check("data:image/png;base64,AAAA")).toEqual({ allowed: true });
    expect(await check("http://127.0.0.1/")).toMatchObject({ allowed: false });
    expect(await check("http://redis/")).toMatchObject({ allowed: false });
    expect(await check("https://ok.example.com/a.js")).toEqual({ allowed: true });
    expect(await check("https://ok.example.com/b.css")).toEqual({ allowed: true });
    expect(await check("https://evil.example.com/")).toMatchObject({ allowed: false });
    expect(lookups).toBe(2); // ok.example.com cached
  });
});

let chromiumAvailable = true;
try {
  const puppeteer = await import("puppeteer");
  const b = await puppeteer.default.launch({ headless: true, args: ["--no-sandbox"] });
  await b.close();
} catch {
  chromiumAvailable = false;
}

describe.skipIf(!chromiumAvailable)("launchBrowser with real Chromium", () => {
  let server: http.Server;
  let port: number;
  let hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.setHeader("content-type", "text/html");
      res.end("<h1>internal admin</h1>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("blocks a top-level navigation to an internal address", async () => {
    hits = [];
    const browser = await launchBrowser({ headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await expect(page.goto(`http://127.0.0.1:${port}/admin`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      expect(hits).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("blocks sub-resources and fetch() from a page to internal addresses", async () => {
    hits = [];
    const browser = await launchBrowser({ headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      // A data: page (allowed) that tries to load internal resources.
      const html = `<img src="http://127.0.0.1:${port}/img"><script>fetch("http://127.0.0.1:${port}/xhr").catch(()=>{})</script>`;
      await page.goto(`data:text/html,${encodeURIComponent(html)}`);
      await new Promise((r) => setTimeout(r, 500));
      expect(hits).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
