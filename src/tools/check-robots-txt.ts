import { z } from "zod";
import { fetchUrl, checkUrl } from "../utils/fetcher.js";
import {
  type StandardResponse,
  createMeta,
  createIssue,
  generateRecommendations,
} from "../utils/response.js";

export const checkRobotsTxtSchema = {
  url: z.string().url().describe("The site URL (robots.txt will be fetched from the origin)"),
};

interface UserAgentBlock {
  agent: string;
  rules: { type: "allow" | "disallow"; path: string }[];
}

interface SitemapStatus {
  url: string;
  accessible: boolean;
  status: number;
}

interface DetectedSitemap {
  url: string;
  declaredInRobots: boolean;
  status: number;
}

function parseRobotsTxtFull(text: string): {
  userAgents: UserAgentBlock[];
  crawlDelay: number | null;
  sitemaps: string[];
} {
  const lines = text.split("\n").map((l) => l.trim());
  const sitemaps: string[] = [];
  let crawlDelay: number | null = null;

  const agentMap = new Map<string, { type: "allow" | "disallow"; path: string }[]>();
  let currentAgent: string | null = null;

  for (const line of lines) {
    if (line.startsWith("#") || line === "") continue;

    const sitemapMatch = line.match(/^sitemap:\s*(.+)/i);
    if (sitemapMatch) {
      sitemaps.push(sitemapMatch[1].trim());
      continue;
    }

    const uaMatch = line.match(/^user-agent:\s*(.+)/i);
    if (uaMatch) {
      currentAgent = uaMatch[1].trim().toLowerCase();
      if (!agentMap.has(currentAgent)) {
        agentMap.set(currentAgent, []);
      }
      continue;
    }

    if (!currentAgent) continue;

    const disallowMatch = line.match(/^disallow:\s*(.*)/i);
    if (disallowMatch) {
      const path = disallowMatch[1].trim();
      if (path) {
        agentMap.get(currentAgent)!.push({ type: "disallow", path });
      }
      continue;
    }

    const allowMatch = line.match(/^allow:\s*(.*)/i);
    if (allowMatch) {
      const path = allowMatch[1].trim();
      if (path) {
        agentMap.get(currentAgent)!.push({ type: "allow", path });
      }
      continue;
    }

    const crawlDelayMatch = line.match(/^crawl-delay:\s*(\d+)/i);
    if (crawlDelayMatch) {
      crawlDelay = parseInt(crawlDelayMatch[1], 10);
    }
  }

  const userAgents: UserAgentBlock[] = [];
  for (const [agent, rules] of agentMap) {
    userAgents.push({ agent, rules });
  }

  return { userAgents, crawlDelay, sitemaps };
}

export async function checkRobotsTxt({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();
  const origin = new URL(url).origin;
  const robotsUrl = `${origin}/robots.txt`;

  // Fetch robots.txt
  let rawContent = "";
  let robotsStatus = 0;
  let robotsFound = false;

  try {
    const result = await fetchUrl(robotsUrl, {
      timeout: 10000,
      usePuppeteerFallback: false,
      maxRetries: 1,
    });
    robotsStatus = result.status;
    rawContent = result.body;
    robotsFound = result.status === 200;
  } catch {
    robotsFound = false;
  }

  // Parse
  const parsed = robotsFound
    ? parseRobotsTxtFull(rawContent)
    : { userAgents: [], crawlDelay: null, sitemaps: [] };

  // Check declared sitemaps accessibility
  const declaredSitemaps: SitemapStatus[] = [];
  for (const sitemapUrl of parsed.sitemaps) {
    const check = await checkUrl(sitemapUrl, 10000);
    declaredSitemaps.push({
      url: sitemapUrl,
      accessible: check.ok,
      status: check.status,
    });
  }

  // Probe common sitemap locations
  const commonSitemapUrls = [
    `${origin}/sitemap.xml`,
    `${origin}/1_index_sitemap.xml`,
  ];

  const declaredSet = new Set(parsed.sitemaps);
  const detectedSitemaps: DetectedSitemap[] = [];

  // Add declared ones first
  for (const ds of declaredSitemaps) {
    detectedSitemaps.push({
      url: ds.url,
      declaredInRobots: true,
      status: ds.status,
    });
  }

  // Probe undeclared ones
  for (const probeUrl of commonSitemapUrls) {
    if (declaredSet.has(probeUrl)) continue;
    const check = await checkUrl(probeUrl, 10000);
    if (check.ok) {
      detectedSitemaps.push({
        url: probeUrl,
        declaredInRobots: false,
        status: check.status,
      });
    }
  }

  // Inconsistencies
  const inconsistencies: string[] = [];

  const inaccessibleDeclared = declaredSitemaps.filter((s) => !s.accessible);
  for (const s of inaccessibleDeclared) {
    inconsistencies.push(`Sitemap declared in robots.txt but inaccessible: ${s.url} (status ${s.status})`);
  }

  const undeclaredFound = detectedSitemaps.filter((s) => !s.declaredInRobots);
  for (const s of undeclaredFound) {
    inconsistencies.push(`Sitemap found but not declared in robots.txt: ${s.url}`);
  }

  // Build issues
  const issues = [];

  if (!robotsFound) {
    issues.push(createIssue("error", "robots-txt", `robots.txt not found or inaccessible (status ${robotsStatus})`, robotsUrl));
  } else {
    issues.push(createIssue("info", "robots-txt", `robots.txt found (${rawContent.length} bytes)`, robotsUrl));
  }

  if (parsed.sitemaps.length === 0) {
    issues.push(createIssue("warning", "sitemap-declaration", "No sitemap declared in robots.txt"));
  }

  for (const s of inaccessibleDeclared) {
    issues.push(createIssue("error", "sitemap-accessibility", `Declared sitemap inaccessible: ${s.url} (status ${s.status})`, s.url));
  }

  for (const s of undeclaredFound) {
    issues.push(createIssue("warning", "sitemap-undeclared", `Sitemap found but not declared in robots.txt: ${s.url}`, s.url));
  }

  if (parsed.crawlDelay === null) {
    issues.push(createIssue("info", "crawl-delay", "No Crawl-delay directive found"));
  } else {
    issues.push(createIssue("info", "crawl-delay", `Crawl-delay set to ${parsed.crawlDelay}s`));
  }

  // Score
  let score = 100;
  if (!robotsFound) score -= 30;
  if (parsed.sitemaps.length === 0) score -= 15;
  score -= inaccessibleDeclared.length * 10;
  score -= undeclaredFound.length * 10;
  score = Math.max(0, score);

  return {
    url,
    finalUrl: robotsUrl,
    status: robotsStatus,
    score,
    summary: `robots.txt de ${origin}: ${robotsFound ? "trouvé" : "absent"}, ${parsed.sitemaps.length} sitemaps déclarés, ${detectedSitemaps.length} détectés`,
    issues,
    recommendations: generateRecommendations(issues),
    meta: createMeta(startTime, "fetch", false, false),
    data: {
      rawContent: rawContent.length > 5000 ? rawContent.slice(0, 5000) + "\n... [truncated]" : rawContent,
      userAgents: parsed.userAgents,
      crawlDelay: parsed.crawlDelay,
      declaredSitemaps,
      detectedSitemaps,
      inconsistencies,
    },
  };
}
