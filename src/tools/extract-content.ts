import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import {
  extractMetadata,
  extractHeadings,
  extractLinks,
  extractImages,
  extractTextContent,
} from "../utils/html-parser.js";

export const extractContentSchema = {
  url: z.string().url().describe("The URL to extract content from"),
};

export async function extractContent({ url }: { url: string }) {
  const result = await fetchUrl(url);
  const baseUrl = result.finalUrl;

  const metadata = extractMetadata(result.body, baseUrl);
  const headings = extractHeadings(result.body);
  const links = extractLinks(result.body, baseUrl);
  const images = extractImages(result.body, baseUrl);
  const textContent = extractTextContent(result.body);

  return {
    url: result.url,
    finalUrl: baseUrl,
    status: result.status,
    title: metadata.title,
    description: metadata.description,
    lang: metadata.lang,
    headings,
    links: links.slice(0, 100), // Limit to first 100 links
    images: images.slice(0, 50), // Limit to first 50 images
    textContent:
      textContent.length > 10000
        ? textContent.slice(0, 10000) + "\n... [truncated]"
        : textContent,
    stats: {
      headingsCount: headings.length,
      linksCount: links.length,
      internalLinksCount: links.filter((l) => l.isInternal).length,
      externalLinksCount: links.filter((l) => !l.isInternal).length,
      imagesCount: images.length,
      textLength: textContent.length,
    },
  };
}
