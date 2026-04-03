import { z } from "zod";
import { fetchUrl } from "../utils/fetcher.js";
import { extractMetadata } from "../utils/html-parser.js";
import { htmlToMarkdown, extractTextContent } from "../utils/html-parser.js";
import {
  type StandardResponse,
  createMeta,
} from "../utils/response.js";

export const fetchPageSchema = {
  url: z.string().url().describe("The URL to fetch"),
  format: z
    .enum(["html", "text", "markdown"])
    .default("markdown")
    .describe("Output format: html (raw HTML), text (plain text), or markdown"),
  headers: z
    .record(z.string())
    .optional()
    .describe("Optional custom HTTP headers"),
};

export async function fetchPage({
  url,
  format,
  headers,
}: {
  url: string;
  format: "html" | "text" | "markdown";
  headers?: Record<string, string>;
}): Promise<StandardResponse> {
  const startTime = performance.now();
  const result = await fetchUrl(url, { headers });
  const metadata = extractMetadata(result.body, result.finalUrl);

  let content: string;
  switch (format) {
    case "html":
      content = result.body;
      break;
    case "text":
      content = extractTextContent(result.body);
      break;
    case "markdown":
      content = htmlToMarkdown(result.body);
      break;
  }

  return {
    url: result.url,
    finalUrl: result.finalUrl,
    status: result.status,
    summary: `Fetch de ${result.finalUrl}: status ${result.status}, ${content.length} caractères en format ${format}`,
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
      contentType: result.headers["content-type"] || null,
      content,
      redirected: result.redirected,
    },
  };
}
