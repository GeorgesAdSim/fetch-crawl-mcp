export interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  maxRetries?: number;
  followRedirects?: boolean;
  usePuppeteerFallback?: boolean;
}

export interface AntiBotInfo {
  blocked: boolean;
  provider: string | null;
  confidence: "high" | "medium" | "low";
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
  durationMs: number;
  partial: boolean;
  antiBot?: AntiBotInfo;
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB

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

export function jitter(ms: number): number {
  if (ms <= 0) return 0;
  const variance = ms * 0.3;
  return Math.round(ms + (Math.random() * 2 - 1) * variance);
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const BLOCK_STATUS_CODES = new Set([403, 503]);

export function detectAntiBot(
  status: number,
  body: string,
  headers: Record<string, string>
): AntiBotInfo {
  const lower = body.toLowerCase();
  const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
  const headerMap: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    headerMap[k.toLowerCase()] = v;
  }

  // Cloudflare
  if (
    headerMap["cf-ray"] ||
    (BLOCK_STATUS_CODES.has(status) &&
      (lower.includes("cloudflare") ||
        lower.includes("cf-browser-verification") ||
        lower.includes("just a moment") ||
        lower.includes("checking your browser")))
  ) {
    const hasRay = !!headerMap["cf-ray"];
    const hasBodyMatch =
      lower.includes("cloudflare") || lower.includes("just a moment");
    return {
      blocked: BLOCK_STATUS_CODES.has(status) && (hasRay || hasBodyMatch),
      provider: "Cloudflare",
      confidence: hasRay && hasBodyMatch ? "high" : hasRay ? "medium" : "medium",
    };
  }

  // DataDome
  if (
    headerMap["x-datadome"] ||
    headerMap["set-cookie"]?.includes("datadome")
  ) {
    return {
      blocked: BLOCK_STATUS_CODES.has(status),
      provider: "DataDome",
      confidence: "high",
    };
  }

  // Akamai
  if (
    headerKeys.some((k) => k.includes("akamai")) ||
    headerMap["x-akamai-transformed"]
  ) {
    return {
      blocked: BLOCK_STATUS_CODES.has(status),
      provider: "Akamai",
      confidence: BLOCK_STATUS_CODES.has(status) ? "medium" : "low",
    };
  }

  // Sucuri
  if (headerMap["x-sucuri-id"] || headerMap["x-sucuri-cache"]) {
    return {
      blocked: BLOCK_STATUS_CODES.has(status),
      provider: "Sucuri",
      confidence: "high",
    };
  }

  // PerimeterX
  if (
    headerMap["set-cookie"]?.includes("_px") ||
    lower.includes("perimeterx") ||
    lower.includes("human challenge")
  ) {
    return {
      blocked: BLOCK_STATUS_CODES.has(status),
      provider: "PerimeterX",
      confidence:
        BLOCK_STATUS_CODES.has(status) && lower.includes("perimeterx")
          ? "high"
          : "medium",
    };
  }

  // Generic bot detection
  if (
    BLOCK_STATUS_CODES.has(status) &&
    (lower.includes("captcha") ||
      lower.includes("access denied") ||
      lower.includes("bot detection") ||
      lower.includes("are you a robot"))
  ) {
    return {
      blocked: true,
      provider: null,
      confidence: "medium",
    };
  }

  return { blocked: false, provider: null, confidence: "low" };
}

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

const PUPPETEER_GLOBAL_TIMEOUT = 30000;

const STEALTH_LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-web-security",
  "--window-size=1920,1080",
];

async function applyStealthPatches(page: { evaluateOnNewDocument: (fn: (...args: unknown[]) => void) => Promise<unknown> }): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Fake plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => {
        const plugins = [
          { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
          { name: "Native Client", filename: "internal-nacl-plugin", description: "" },
          { name: "Chromium PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
          { name: "Chromium PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
        ];
        const pluginArray = Object.create(PluginArray.prototype);
        for (let i = 0; i < plugins.length; i++) {
          pluginArray[i] = plugins[i];
        }
        Object.defineProperty(pluginArray, "length", { value: plugins.length });
        return pluginArray;
      },
    });

    // Fake languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["fr-FR", "fr", "en-US", "en"],
    });

    // Fake platform
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });

    // Fake hardware concurrency
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });

    // Fake device memory
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

    // Patch chrome.runtime
    if (!(window as unknown as Record<string, unknown>).chrome) {
      (window as unknown as Record<string, unknown>).chrome = {};
    }
    const chrome = (window as unknown as Record<string, Record<string, unknown>>).chrome;
    if (!chrome.runtime) {
      chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
      };
    }

    // Patch Notification permissions
    const originalQuery = window.navigator.permissions.query.bind(
      window.navigator.permissions
    );
    window.navigator.permissions.query = (parameters: PermissionDescriptor) => {
      if (parameters.name === "notifications") {
        return Promise.resolve({
          state: "denied",
          onchange: null,
        } as PermissionStatus);
      }
      return originalQuery(parameters);
    };

    // Patch WebGL renderer
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter: number) {
      const UNMASKED_VENDOR_WEBGL = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;
      if (parameter === UNMASKED_VENDOR_WEBGL) return "Intel Inc.";
      if (parameter === UNMASKED_RENDERER_WEBGL) return "Intel Iris OpenGL Engine";
      return getParameter.call(this, parameter);
    };
  });
}

async function fetchWithPuppeteer(
  url: string,
  timeout: number
): Promise<FetchResult> {
  const startTime = performance.now();
  const puppeteer = await import("puppeteer");
  let browser;
  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: STEALTH_LAUNCH_ARGS,
    });

    const page = await browser.newPage();
    await page.setUserAgent(randomUserAgent());
    await applyStealthPatches(page);

    const effectiveTimeout = Math.min(timeout, PUPPETEER_GLOBAL_TIMEOUT);

    const response = await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: effectiveTimeout,
    });

    let body = await page.content();
    let partial = false;
    if (body.length > MAX_BODY_SIZE) {
      body = body.slice(0, MAX_BODY_SIZE);
      partial = true;
    }

    const status = response?.status() ?? 0;
    const responseHeaders: Record<string, string> = {};
    const rawHeaders = response?.headers() ?? {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      responseHeaders[key] = value;
    }

    const antiBot = detectAntiBot(status, body, responseHeaders);

    return {
      url,
      finalUrl: page.url(),
      status,
      statusText: status === 200 ? "OK" : `${status}`,
      headers: responseHeaders,
      body,
      redirected: page.url() !== url,
      fetchedWith: "puppeteer",
      durationMs: Math.round(performance.now() - startTime),
      partial,
      antiBot: antiBot.blocked ? antiBot : undefined,
    };
  } finally {
    if (browser) await browser.close();
  }
}

export async function withPuppeteerTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number = PUPPETEER_GLOBAL_TIMEOUT
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Puppeteer operation timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

export { STEALTH_LAUNCH_ARGS, applyStealthPatches, randomUserAgent };

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

  const startTime = performance.now();
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

      let body = await response.text();
      let partial = false;
      if (body.length > MAX_BODY_SIZE) {
        body = body.slice(0, MAX_BODY_SIZE);
        partial = true;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const antiBot = detectAntiBot(response.status, body, responseHeaders);

      if (usePuppeteerFallback && looksBlocked(response.status, body)) {
        console.error(
          `Anti-bot block detected on ${url} (status ${response.status}, provider: ${antiBot.provider ?? "unknown"}), falling back to Puppeteer`
        );
        try {
          return await fetchWithPuppeteer(url, timeout);
        } catch {
          // Puppeteer fallback also failed — return blocked response
          return {
            url,
            finalUrl: response.url,
            status: 403,
            statusText: "Blocked",
            headers: responseHeaders,
            body,
            redirected: response.redirected,
            fetchedWith: "puppeteer",
            durationMs: Math.round(performance.now() - startTime),
            partial,
            antiBot: {
              blocked: true,
              provider: antiBot.provider,
              confidence: antiBot.confidence,
            },
          };
        }
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
        durationMs: Math.round(performance.now() - startTime),
        partial,
        antiBot: antiBot.blocked ? antiBot : undefined,
      };
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

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
