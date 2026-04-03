import { sleep } from "./fetcher.js";

interface RobotsRules {
  disallowed: string[];
  crawlDelay: number | null;
  sitemaps: string[];
}

export async function fetchRobotsTxt(
  baseUrl: string
): Promise<RobotsRules> {
  const rules: RobotsRules = {
    disallowed: [],
    crawlDelay: null,
    sitemaps: [],
  };

  try {
    const url = new URL("/robots.txt", baseUrl).toString();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: { "User-Agent": "FetchCrawlMCP/1.0" },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) return rules;

    const text = await response.text();
    return parseRobotsTxt(text);
  } catch {
    return rules;
  }
}

export function parseRobotsTxt(text: string): RobotsRules {
  const rules: RobotsRules = {
    disallowed: [],
    crawlDelay: null,
    sitemaps: [],
  };

  const lines = text.split("\n").map((l) => l.trim());
  let inWildcardBlock = false;

  for (const line of lines) {
    if (line.startsWith("#") || line === "") continue;

    const sitemapMatch = line.match(/^sitemap:\s*(.+)/i);
    if (sitemapMatch) {
      rules.sitemaps.push(sitemapMatch[1].trim());
      continue;
    }

    const uaMatch = line.match(/^user-agent:\s*(.+)/i);
    if (uaMatch) {
      const agent = uaMatch[1].trim().toLowerCase();
      inWildcardBlock = agent === "*";
      continue;
    }

    if (!inWildcardBlock) continue;

    const disallowMatch = line.match(/^disallow:\s*(.*)/i);
    if (disallowMatch) {
      const path = disallowMatch[1].trim();
      if (path) rules.disallowed.push(path);
      continue;
    }

    const crawlDelayMatch = line.match(/^crawl-delay:\s*(\d+)/i);
    if (crawlDelayMatch) {
      rules.crawlDelay = parseInt(crawlDelayMatch[1], 10);
    }
  }

  return rules;
}

export function isAllowedByRobots(
  urlStr: string,
  disallowed: string[]
): boolean {
  try {
    const path = new URL(urlStr).pathname;
    for (const rule of disallowed) {
      if (rule.includes("*")) {
        const regex = new RegExp(
          "^" + rule.replace(/\*/g, ".*").replace(/\$/g, "$")
        );
        if (regex.test(path)) return false;
      } else if (path.startsWith(rule)) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}
