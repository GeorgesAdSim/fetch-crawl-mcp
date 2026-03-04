import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchPageSchema, fetchPage } from "./tools/fetch-page.js";
import { crawlSiteSchema, crawlSite } from "./tools/crawl-site.js";
import {
  extractContentSchema,
  extractContent,
} from "./tools/extract-content.js";
import {
  extractLinksSchema,
  extractLinks,
} from "./tools/extract-links.js";
import { auditOnpageSchema, auditOnpage } from "./tools/analyze-seo.js";
import {
  parseSitemapSchema,
  parseSitemap,
} from "./tools/parse-sitemap.js";
import { checkLinksSchema, checkLinks } from "./tools/check-links.js";
import { screenshotSchema, screenshot } from "./tools/screenshot.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fetch-crawl-mcp",
    version: "1.0.0",
  });

  // Tool: fetch_page
  server.registerTool(
    "fetch_page",
    {
      title: "Fetch Page",
      description:
        "Fetch a web page and return its content in the specified format (HTML, plain text, or markdown). Includes basic metadata.",
      inputSchema: fetchPageSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await fetchPage(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: crawl_site
  server.registerTool(
    "crawl_site",
    {
      title: "Crawl Site",
      description:
        "Crawl a website recursively starting from a URL. Follows internal links up to a specified depth and max pages. Returns a list of discovered pages with their titles and status codes.",
      inputSchema: crawlSiteSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await crawlSite(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: extract_content
  server.registerTool(
    "extract_content",
    {
      title: "Extract Content",
      description:
        "Extract structured content from a web page: headings hierarchy, paragraphs, images, links, and plain text content with statistics.",
      inputSchema: extractContentSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await extractContent(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: extract_links
  server.registerTool(
    "extract_links",
    {
      title: "Extract Links",
      description:
        "Extract all links from a web page. Can filter by internal, external, or all links. Returns anchor text, URL, rel attributes, and nofollow status.",
      inputSchema: extractLinksSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await extractLinks(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: audit_onpage
  server.registerTool(
    "audit_onpage",
    {
      title: "Audit On-Page",
      description:
        "Technical on-page HTML audit. Checks title tag, meta description, canonical, robots, lang attribute, heading hierarchy (H1-H6), images alt attributes, Open Graph, Twitter Card, and structured data (JSON-LD). Returns a list of technical issues found. Does NOT analyze keywords, rankings, backlinks, or traffic — use Semrush for that.",
      inputSchema: auditOnpageSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await auditOnpage(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: parse_sitemap
  server.registerTool(
    "parse_sitemap",
    {
      title: "Parse Sitemap",
      description:
        "Parse a sitemap.xml file (or auto-detect it from a website URL). Supports sitemap index files and returns all discovered URLs with lastmod, changefreq, and priority.",
      inputSchema: parseSitemapSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await parseSitemap(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_links
  server.registerTool(
    "check_links",
    {
      title: "Check Links",
      description:
        "Check all links on a web page for broken links (404, timeout, connection errors). Returns broken, redirected, and OK links with their status codes.",
      inputSchema: checkLinksSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkLinks(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: screenshot
  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture a screenshot of a web page using a headless browser. Returns a PNG image as base64. Supports custom viewport size and full-page capture.",
      inputSchema: screenshotSchema,
    },
    async (args) => {
      const result = await screenshot(args);
      return {
        content: [
          {
            type: "image",
            data: result.imageBase64,
            mimeType: result.mimeType,
          },
        ],
      };
    }
  );

  return server;
}
