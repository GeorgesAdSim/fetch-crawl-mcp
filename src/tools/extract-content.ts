import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractLinks,
  extractImages,
  extractTextContent,
} from "../utils/html-parser.js";
import {
  type StandardResponse,
  createMeta,
} from "../utils/response.js";

export const extractContentSchema = {
  url: z.string().url().describe("The URL to extract content from"),
};

export async function extractContent({ url }: { url: string }): Promise<StandardResponse> {
  const startTime = performance.now();
  const result = await fetchUrl(url);
  const baseUrl = result.finalUrl;

  const metadata = extractMetadata(result.body, baseUrl);
  const headings = extractHeadings(result.body);
  const links = extractLinks(result.body, baseUrl);
  const images = extractImages(result.body, baseUrl);
  const textContent = extractTextContent(result.body);

  const stats = {
    headingsCount: headings.length,
    linksCount: links.length,
    internalLinksCount: links.filter((l) => l.isInternal).length,
    externalLinksCount: links.filter((l) => !l.isInternal).length,
    imagesCount: images.length,
    textLength: textContent.length,
  };

  return {
    url: result.url,
    finalUrl: baseUrl,
    status: result.status,
    summary: `Extraction de ${baseUrl}: ${stats.headingsCount} headings, ${stats.linksCount} liens, ${stats.textLength} caractères`,
    issues: [],
    recommendations: [],
    meta: createMeta(
      startTime,
      result.fetchedWith,
      result.fetchedWith === "puppeteer",
      result.partial
    ),
    data: {
      title: metadata.title,
      description: metadata.description,
      lang: metadata.lang,
      headings,
      links: links.slice(0, 100),
      images: images.slice(0, 50),
      textContent:
        textContent.length > 10000
          ? textContent.slice(0, 10000) + "\n... [truncated]"
          : textContent,
      stats,
    },
  };
}
