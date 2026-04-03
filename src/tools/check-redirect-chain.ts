import { z } from "zod";

export const checkRedirectChainSchema = {
  url: z.string().url().describe("The URL to follow redirects for"),
  maxRedirects: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe("Maximum number of redirects to follow"),
};

type Severity = "error" | "warning" | "info";

interface Hop {
  url: string;
  status: number;
  locationHeader: string | null;
  serverHeader: string | null;
}

interface Issue {
  severity: Severity;
  message: string;
}

export async function checkRedirectChain({
  url,
  maxRedirects,
}: {
  url: string;
  maxRedirects: number;
}) {
  const chain: Hop[] = [];
  const seen = new Set<string>();
  let currentUrl = url;
  let hasLoop = false;

  for (let i = 0; i < maxRedirects; i++) {
    if (seen.has(currentUrl)) {
      hasLoop = true;
      break;
    }
    seen.add(currentUrl);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
    } catch (err) {
      chain.push({
        url: currentUrl,
        status: 0,
        locationHeader: null,
        serverHeader: null,
      });
      break;
    } finally {
      clearTimeout(timeoutId);
    }

    const locationHeader = response.headers.get("location");
    const serverHeader = response.headers.get("server");

    chain.push({
      url: currentUrl,
      status: response.status,
      locationHeader,
      serverHeader,
    });

    const isRedirect =
      response.status >= 300 && response.status < 400 && locationHeader;

    if (!isRedirect) {
      break;
    }

    // Resolve relative Location headers
    currentUrl = new URL(locationHeader!, currentUrl).href;
  }

  const totalRedirects = Math.max(0, chain.length - 1);
  const last = chain[chain.length - 1];
  const finalUrl = last?.url ?? url;
  const finalStatus = last?.status ?? 0;

  // Build issues
  const issues: Issue[] = [];

  if (hasLoop) {
    issues.push({
      severity: "error",
      message: `Redirect loop detected: ${currentUrl} appeared twice in the chain`,
    });
  }

  if (totalRedirects > 3) {
    issues.push({
      severity: "warning",
      message: `Long redirect chain: ${totalRedirects} redirects (recommended: 3 or fewer)`,
    });
  }

  // Detect HTTP → HTTPS upgrade
  for (let i = 0; i < chain.length - 1; i++) {
    const from = new URL(chain[i].url);
    const loc = chain[i].locationHeader;
    const to = loc ? new URL(loc, chain[i].url) : null;
    if (
      to &&
      from.protocol === "http:" &&
      to.protocol === "https:" &&
      from.hostname === to.hostname
    ) {
      issues.push({
        severity: "info",
        message: `HTTP → HTTPS redirect detected at hop ${i + 1}: ${chain[i].url}`,
      });
    }
  }

  return {
    chain,
    totalRedirects,
    finalUrl,
    finalStatus,
    hasLoop,
    issues,
  };
}
