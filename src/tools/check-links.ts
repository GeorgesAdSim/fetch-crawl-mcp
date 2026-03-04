import { z } from "zod";
import { fetchUrl, checkUrl, jitter, sleep } from "../utils/fetcher.js";
import { extractLinks } from "../utils/html-parser.js";

export const checkLinksSchema = {
  url: z.string().url().describe("The URL to check links on"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(30000)
    .default(5000)
    .describe("Timeout in milliseconds for each link check"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(3)
    .describe(
      "Number of links to check simultaneously (default: 3, keeps load low on target servers)"
    ),
  delay: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .default(200)
    .describe(
      "Base delay in ms between batches. A random jitter of ±30% is applied automatically (default: 200ms)"
    ),
};

interface LinkCheckResult {
  url: string;
  text: string;
  status: number;
  ok: boolean;
  finalUrl: string;
  isInternal: boolean;
  error?: string;
}

export async function checkLinks({
  url,
  timeout,
  concurrency,
  delay,
}: {
  url: string;
  timeout: number;
  concurrency: number;
  delay: number;
}) {
  // Fetch the page
  const result = await fetchUrl(url);
  const links = extractLinks(result.body, result.finalUrl);

  // Deduplicate links by href
  const seen = new Set<string>();
  const uniqueLinks = links.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  // Check links in batches with throttling + jitter
  const results: LinkCheckResult[] = [];

  for (let i = 0; i < uniqueLinks.length; i += concurrency) {
    // Pause between batches with jitter (skip for the first batch)
    if (i > 0 && delay > 0) {
      await sleep(jitter(delay));
    }

    const batch = uniqueLinks.slice(i, i + concurrency);
    const checks = await Promise.all(
      batch.map(async (link) => {
        const check = await checkUrl(link.href, timeout);
        return {
          url: link.href,
          text: link.text || "[no text]",
          status: check.status,
          ok: check.ok,
          finalUrl: check.finalUrl,
          isInternal: link.isInternal,
          error: check.error,
        };
      })
    );
    results.push(...checks);
  }

  const broken = results.filter((r) => !r.ok);
  const redirected = results.filter(
    (r) => r.ok && r.finalUrl !== r.url
  );

  return {
    url: result.url,
    finalUrl: result.finalUrl,
    totalLinks: results.length,
    okCount: results.filter((r) => r.ok && r.finalUrl === r.url).length,
    brokenCount: broken.length,
    redirectCount: redirected.length,
    broken: broken.map((r) => ({
      url: r.url,
      text: r.text,
      status: r.status,
      isInternal: r.isInternal,
      error: r.error,
    })),
    redirected: redirected.slice(0, 20).map((r) => ({
      url: r.url,
      text: r.text,
      status: r.status,
      finalUrl: r.finalUrl,
      isInternal: r.isInternal,
    })),
    allLinks: results,
  };
}
