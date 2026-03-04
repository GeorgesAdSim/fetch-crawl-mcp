/**
 * Normalize a URL by removing fragments, trailing slashes, and lowercasing the host.
 */
export function normalizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    url.hash = "";
    // Remove trailing slash except for root
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Resolve a potentially relative URL against a base URL.
 */
export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/**
 * Check if two URLs belong to the same domain.
 */
export function isSameDomain(url1: string, url2: string): boolean {
  try {
    const a = new URL(url1);
    const b = new URL(url2);
    return a.hostname === b.hostname;
  } catch {
    return false;
  }
}

/**
 * Check if a URL is internal relative to a base URL.
 */
export function isInternalUrl(baseUrl: string, targetUrl: string): boolean {
  return isSameDomain(baseUrl, targetUrl);
}

/**
 * Get the domain from a URL.
 */
export function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "";
  }
}

/**
 * Check if URL is valid HTTP(S).
 */
export function isHttpUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build a sitemap URL from a base URL.
 */
export function getSitemapUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    return `${url.protocol}//${url.host}/sitemap.xml`;
  } catch {
    return `${urlStr}/sitemap.xml`;
  }
}
