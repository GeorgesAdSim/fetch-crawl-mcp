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
import {
  checkPerformanceSchema,
  checkPerformance,
} from "./tools/check-performance.js";
import {
  checkRedirectChainSchema,
  checkRedirectChain,
} from "./tools/check-redirect-chain.js";
import {
  checkMobileSchema,
  checkMobile,
} from "./tools/check-mobile.js";
import {
  checkStructuredDataSchema,
  checkStructuredData,
} from "./tools/check-structured-data.js";
import {
  checkRobotsTxtSchema,
  checkRobotsTxt,
} from "./tools/check-robots-txt.js";
import {
  checkIndexabilitySchema,
  checkIndexability,
} from "./tools/check-indexability.js";
import {
  comparePagesSchema,
  comparePages,
} from "./tools/compare-pages.js";
import {
  auditSiteBatchSchema,
  auditSiteBatch,
} from "./tools/audit-site-batch.js";
import {
  extractWithSchemaSchema,
  extractWithSchema,
} from "./tools/extract-with-schema.js";
import {
  detectOrphanPagesSchema,
  detectOrphanPages,
} from "./tools/detect-orphan-pages.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fetch-crawl-mcp",
    version: "3.1.0",
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
        "Capture a screenshot of a web page using a headless browser. Returns an image as base64 (PNG or JPEG). Supports custom viewport size, full-page capture, waiting for a CSS selector, and dismissing cookie consent banners.",
      inputSchema: screenshotSchema,
    },
    async (args) => {
      const result = await screenshot(args);
      if ("error" in result) {
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }
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

  // Tool: check_performance
  server.registerTool(
    "check_performance",
    {
      title: "Check Performance",
      description:
        "Measure web page performance metrics (TTFB, FCP, LCP, DOM Content Loaded, Fully Loaded) using a headless browser. Supports mobile (with network throttling) and desktop profiles. Returns a 0-100 score, detailed timings, network stats, and actionable issues.",
      inputSchema: checkPerformanceSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkPerformance(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_redirect_chain
  server.registerTool(
    "check_redirect_chain",
    {
      title: "Check Redirect Chain",
      description:
        "Follow the redirect chain of a URL hop by hop (using manual redirect). Returns each hop with status, Location header, and Server header. Detects redirect loops, long chains, and HTTP-to-HTTPS upgrades.",
      inputSchema: checkRedirectChainSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkRedirectChain(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_mobile
  server.registerTool(
    "check_mobile",
    {
      title: "Check Mobile",
      description:
        "Audit a web page for mobile-friendliness using a headless browser with iPhone viewport (375x812) and mobile User-Agent. Checks viewport meta, horizontal scroll, font sizes, tap target sizes, and returns a mobile screenshot.",
      inputSchema: checkMobileSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkMobile(args);
      const mobileData = result.data as Record<string, unknown>;
      const screenshotBase64 = mobileData.screenshotBase64 as string;
      const screenshotMimeType = mobileData.screenshotMimeType as string;
      const jsonResult = { ...result, data: { ...mobileData, screenshotBase64: "(see image below)" } };
      return {
        content: [
          { type: "text", text: JSON.stringify(jsonResult, null, 2) },
          {
            type: "image",
            data: screenshotBase64,
            mimeType: screenshotMimeType,
          },
        ],
      };
    }
  );

  // Tool: check_structured_data
  server.registerTool(
    "check_structured_data",
    {
      title: "Check Structured Data",
      description:
        "Extract and validate structured data from a web page: JSON-LD (with type-specific validation for Product, Organization, BreadcrumbList, Article), Microdata, Open Graph, and Twitter Card meta tags.",
      inputSchema: checkStructuredDataSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkStructuredData(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_robots_txt
  server.registerTool(
    "check_robots_txt",
    {
      title: "Check Robots.txt",
      description:
        "Analyze a site's robots.txt: parse rules per User-Agent (Allow/Disallow), Crawl-delay, declared sitemaps, and cross-check sitemap accessibility. Detects undeclared sitemaps and inconsistencies.",
      inputSchema: checkRobotsTxtSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkRobotsTxt(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_indexability
  server.registerTool(
    "check_indexability",
    {
      title: "Check Indexability",
      description:
        "Check if a page is indexable by search engines. Analyzes HTTP status, meta robots, X-Robots-Tag, canonical tag, hreflang, and sitemap presence. Returns a verdict with detailed reasoning.",
      inputSchema: checkIndexabilitySchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkIndexability(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: compare_pages
  server.registerTool(
    "compare_pages",
    {
      title: "Compare Pages",
      description:
        "Compare two web pages side by side on SEO criteria: title, meta description, headings, word count, links, images alt, Open Graph, Twitter Card, JSON-LD, and canonical. Optionally captures screenshots of both pages.",
      inputSchema: comparePagesSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await comparePages(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: audit_site_batch
  server.registerTool(
    "audit_site_batch",
    {
      title: "Audit Site Batch",
      description:
        "Batch audit multiple pages of a site. Collects URLs from sitemap, crawl, or a provided list, then runs a lightweight SEO audit on each page. Returns aggregate scores, top problems, quick wins, and critical pages.",
      inputSchema: auditSiteBatchSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await auditSiteBatch(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: detect_orphan_pages
  server.registerTool(
    "detect_orphan_pages",
    {
      title: "Detect Orphan Pages",
      description:
        "Detect orphan pages by cross-referencing sitemap URLs with crawled pages and internal link graph. Identifies pages with no inbound links (orphans), sitemap-only pages, crawl-only pages, and deep pages. Returns classification, link graph hubs, and sitemap/crawl coherence stats.",
      inputSchema: detectOrphanPagesSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await detectOrphanPages(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: extract_with_schema
  server.registerTool(
    "extract_with_schema",
    {
      title: "Extract With Schema",
      description:
        "Extract structured data from a web page using configurable CSS selectors. Supports custom schemas and built-in presets (ecommerce-product, article, local-business, recipe). Each field defines a CSS selector, optional attribute, multiple flag, and transform (text, html, number, trim, href). Fallback selectors can be provided for resilience.",
      inputSchema: extractWithSchemaSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await extractWithSchema(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}
