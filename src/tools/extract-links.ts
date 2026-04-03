import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import { extractLinks as parseLinks } from "../utils/html-parser.js";

export const extractLinksSchema = {
  url: z.string().url().describe("The URL to extract links from"),
  type: z
    .enum(["all", "internal", "external"])
    .default("all")
    .describe("Filter links by type"),
};

export async function extractLinks({
  url,
  type,
}: {
  url: string;
  type: "all" | "internal" | "external";
}) {
  const result = await fetchUrl(url);
  let links = parseLinks(result.body, result.finalUrl);

  switch (type) {
    case "internal":
      links = links.filter((l) => l.isInternal);
      break;
    case "external":
      links = links.filter((l) => !l.isInternal);
      break;
  }

  const seen = new Set<string>();
  const uniqueLinks = links.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });

  return {
    url: result.url,
    finalUrl: result.finalUrl,
    filter: type,
    totalLinks: links.length,
    uniqueLinks: uniqueLinks.length,
    links: uniqueLinks.map((l) => ({
      href: l.href,
      text: l.text || "[no text]",
      rel: l.rel,
      isInternal: l.isInternal,
      isNofollow: l.isNofollow,
    })),
  };
}
