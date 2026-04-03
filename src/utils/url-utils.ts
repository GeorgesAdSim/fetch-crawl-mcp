export function normalizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    url.hash = "";
    if (url.pathname !== "/" && url.pathname.endsWith("/")) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.toString();
  } catch {
    return urlStr;
  }
}

export function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

export function isSameDomain(url1: string, url2: string): boolean {
  try {
    const a = new URL(url1);
    const b = new URL(url2);
    return a.hostname === b.hostname;
  } catch {
    return false;
  }
}

export function isInternalUrl(baseUrl: string, targetUrl: string): boolean {
  return isSameDomain(baseUrl, targetUrl);
}

export function getDomain(urlStr: string): string {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "";
  }
}

export function isHttpUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getSitemapUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    return `${url.protocol}//${url.host}/sitemap.xml`;
  } catch {
    return `${urlStr}/sitemap.xml`;
  }
}
