/**
 * Single entry point for launching Chromium. Every page (including popups
 * opened by the site) gets request interception: any request whose URL is
 * not public — top-level navigation, redirect, iframe, XHR, image… — is
 * aborted before Chromium connects.
 *
 * The guard is the ONLY code allowed to resolve requests (continue/abort).
 * Tools may observe traffic with `page.on("request", …)` — that needs no
 * interception — but must never call `request.continue()` or `abort()`
 * themselves, or they could let a request through before the check ends.
 *
 * Residual risk: Chromium resolves DNS itself after our check, so a hostile
 * DNS server could still rebind between the two lookups. A network-level
 * egress rule on the container is the complete fix (see README).
 */
import type { Browser, HTTPRequest, LaunchOptions, Page } from "puppeteer";
import { assertPublicUrl, BlockedUrlError, checkUrlSyntax } from "./net-guard.js";

const NON_NETWORK_SCHEMES = /^(data|blob|about):/i;
const DNS_CACHE_TTL_MS = 60_000;

type Verdict = { allowed: true } | { allowed: false; reason: string };

/** Per-browser cache of hostname verdicts, so a page with 200 assets does 1 lookup per host. */
export function createRequestChecker(assert: (url: string) => Promise<void> = assertPublicUrl) {
  const cache = new Map<string, { verdict: Verdict; expires: number }>();
  return async (rawUrl: string): Promise<Verdict> => {
    if (NON_NETWORK_SCHEMES.test(rawUrl)) return { allowed: true };
    const syntax = checkUrlSyntax(rawUrl);
    if (syntax) return { allowed: false, reason: syntax };
    const url = new URL(rawUrl);
    const key = `${url.protocol}//${url.host}`;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.verdict;
    let verdict: Verdict;
    try {
      await assert(rawUrl);
      verdict = { allowed: true };
    } catch (e) {
      verdict = { allowed: false, reason: e instanceof BlockedUrlError ? e.reason : "check failed" };
    }
    cache.set(key, { verdict, expires: Date.now() + DNS_CACHE_TTL_MS });
    return verdict;
  };
}

export async function guardPage(page: Page, check: ReturnType<typeof createRequestChecker>): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", async (request: HTTPRequest) => {
    const verdict = await check(request.url());
    try {
      if (verdict.allowed) {
        await request.continue();
      } else {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          console.error(`[net-guard] blocked navigation to ${request.url()}: ${verdict.reason}`);
        }
        await request.abort("blockedbyclient");
      }
    } catch {
      // Page closed or request already cancelled: nothing to do.
    }
  });
}

/** Drop-in replacement for `puppeteer.launch()`. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch(options);
  const check = createRequestChecker();

  // Pages created by our code: guard before returning them to the caller.
  const originalNewPage = browser.newPage.bind(browser);
  const pending = new WeakMap<Page, Promise<void>>();
  const ensureGuarded = (page: Page): Promise<void> => {
    let p = pending.get(page);
    if (!p) {
      p = guardPage(page, check);
      pending.set(page, p);
    }
    return p;
  };

  browser.newPage = async (...args: Parameters<Browser["newPage"]>) => {
    const page = await originalNewPage(...args);
    await ensureGuarded(page);
    return page;
  };

  // Pages opened by the site itself (window.open, target=_blank).
  browser.on("targetcreated", async (target) => {
    if (target.type() !== "page") return;
    const page = await target.page().catch(() => null);
    if (page) await ensureGuarded(page).catch(() => page.close().catch(() => {}));
  });

  // The initial about:blank page, in case a caller uses browser.pages()[0].
  for (const page of await browser.pages()) await ensureGuarded(page);

  return browser;
}
