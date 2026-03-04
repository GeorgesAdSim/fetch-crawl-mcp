export interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  followRedirects?: boolean;
  usePuppeteerFallback?: boolean;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  redirected: boolean;
  fetchedWith: "fetch" | "puppeteer";
}

// ---------------------------------------------------------------------------
// Realistic User-Agent rotation
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:133.0) Gecko/20100101 Firefox/133.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ---------------------------------------------------------------------------
// Jitter: adds ±30% random variance to a delay value
// ---------------------------------------------------------------------------
export function jitter(ms: number): number {
  if (ms <= 0) return 0;
  const variance = ms * 0.3;
  return Math.round(ms + (Math.random() * 2 - 1) * variance);
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Build realistic browser-like headers
// ---------------------------------------------------------------------------
function buildHeaders(
  userHeaders: Record<string, string> = {}
): Record<string, string> {
  return {
    "User-Agent": randomUserAgent(),
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr-FR;q=0.8,fr;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    ...userHeaders,
  };
}

// ---------------------------------------------------------------------------
// Detect if a response looks like an anti-bot block
// ---------------------------------------------------------------------------
const BLOCK_STATUS_CODES = new Set([403, 503]);

function looksBlocked(status: number, body: string): boolean {
  if (!BLOCK_STATUS_CODES.has(status)) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes("cloudflare") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("just a moment") ||
    lower.includes("checking your browser") ||
    lower.includes("captcha") ||
    lower.includes("access denied") ||
    lower.includes("bot detection") ||
    lower.includes("are you a robot")
  );
}

// ---------------------------------------------------------------------------
// Puppeteer fallback – fetch via headless browser
// ---------------------------------------------------------------------------
async function fetchWithPuppeteer(
  url: string,
  timeout: number
): Promise<FetchResult> {
  const puppeteer = await import("puppeteer");
  let browser;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(randomUserAgent());
    // Hide webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout,
    });

    const body = await page.content();
    const status = response?.status() ?? 0;
    const responseHeaders: Record<string, string> = {};
    const rawHeaders = response?.headers() ?? {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      responseHeaders[key] = value;
    }

    return {
      url,
      finalUrl: page.url(),
      status,
      statusText: status === 200 ? "OK" : `${status}`,
      headers: responseHeaders,
      body,
      redirected: page.url() !== url,
      fetchedWith: "puppeteer",
    };
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Main fetch function with anti-bot fallback
// ---------------------------------------------------------------------------
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_MAX_RETRIES = 2;

export async function fetchUrl(
  url: string,
  options: FetchOptions = {}
): Promise<FetchResult> {
  const {
    headers = {},
    timeout = DEFAULT_TIMEOUT,
    maxRetries = DEFAULT_MAX_RETRIES,
    followRedirects = true,
    usePuppeteerFallback = true,
  } = options;

  const requestHeaders = buildHeaders(headers);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        headers: requestHeaders,
        signal: controller.signal,
        redirect: followRedirects ? "follow" : "manual",
      });

      clearTimeout(timeoutId);

      const body = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Detect anti-bot block → fallback to Puppeteer
      if (usePuppeteerFallback && looksBlocked(response.status, body)) {
        console.error(
          `Anti-bot block detected on ${url} (status ${response.status}), falling back to Puppeteer`
        );
        return await fetchWithPuppeteer(url, timeout);
      }

      return {
        url,
        finalUrl: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body,
        redirected: response.redirected,
        fetchedWith: "fetch",
      };
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  // Last resort: try Puppeteer if fetch completely failed
  if (usePuppeteerFallback) {
    try {
      console.error(
        `All fetch attempts failed for ${url}, trying Puppeteer as last resort`
      );
      return await fetchWithPuppeteer(url, timeout);
    } catch {
      // Puppeteer also failed, throw original error
    }
  }

  throw new Error(
    `Failed to fetch ${url} after ${maxRetries + 1} attempts: ${lastError?.message}`
  );
}

// ---------------------------------------------------------------------------
// Lightweight HEAD check for link validation
// ---------------------------------------------------------------------------
export async function checkUrl(
  url: string,
  timeout: number = 5000
): Promise<{ status: number; ok: boolean; finalUrl: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: "HEAD",
      headers: buildHeaders(),
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    // Some servers block HEAD → retry with GET
    if (response.status === 405 || response.status === 403) {
      clearTimeout(timeoutId);
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), timeout);
      const getResponse = await fetch(url, {
        method: "GET",
        headers: buildHeaders(),
        signal: controller2.signal,
        redirect: "follow",
      });
      clearTimeout(timeoutId2);
      // Consume body to free resources
      await getResponse.text();
      return {
        status: getResponse.status,
        ok: getResponse.ok,
        finalUrl: getResponse.url,
      };
    }

    return {
      status: response.status,
      ok: response.ok,
      finalUrl: response.url,
    };
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      return { status: 0, ok: false, finalUrl: url, error: "timeout" };
    }
    return { status: 0, ok: false, finalUrl: url, error: err.message };
  }
}
