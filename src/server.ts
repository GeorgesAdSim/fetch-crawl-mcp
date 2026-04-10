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
import {
  detectDuplicateContentSchema,
  detectDuplicateContent,
} from "./tools/detect-duplicate-content.js";
import {
  checkGtmSnippetSchema,
  checkGtmSnippet,
} from "./tools/check-gtm-snippet.js";
import {
  checkDatalayerSchema,
  checkDatalayer,
} from "./tools/check-datalayer.js";
import {
  interceptTrackingRequestsSchema,
  interceptTrackingRequests,
} from "./tools/intercept-tracking-requests.js";
import {
  auditTrackingSchema,
  auditTracking,
} from "./tools/audit-tracking.js";
import {
  checkSecurityHeadersSchema,
  checkSecurityHeaders,
} from "./tools/check-security-headers.js";
import {
  checkHreflangSchema,
  checkHreflang,
} from "./tools/check-hreflang.js";
import {
  auditContentQualitySchema,
  auditContentQuality,
} from "./tools/audit-content-quality.js";
import {
  checkAccessibilitySchema,
  checkAccessibility,
} from "./tools/check-accessibility.js";
import {
  extractImagesAuditSchema,
  extractImagesAudit,
} from "./tools/extract-images-audit.js";
import {
  checkConsentModeSchema,
  checkConsentMode,
} from "./tools/check-consent-mode.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "fetch-crawl-mcp",
    version: "4.1.0",
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

  // Tool: detect_duplicate_content
  server.registerTool(
    "detect_duplicate_content",
    {
      title: "Detect Duplicate Content",
      description:
        "Detect duplicate and near-duplicate content across a site's pages. Analyzes titles, meta descriptions, H1 headings, and text content. Groups exact duplicates and identifies near-duplicates based on word similarity. Supports sitemap, crawl, or custom URL list as page source.",
      inputSchema: detectDuplicateContentSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await detectDuplicateContent(args);
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

  // Tool: check_gtm_snippet
  server.registerTool(
    "check_gtm_snippet",
    {
      title: "Check GTM Snippet",
      description:
        "Check a page for Google Tag Manager (GTM) and gtag.js snippets. Detects GTM container IDs, GA4 measurement IDs, verifies snippet placement (head vs body), noscript fallback, and duplicate IDs.",
      inputSchema: checkGtmSnippetSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkGtmSnippet(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_datalayer
  server.registerTool(
    "check_datalayer",
    {
      title: "Check DataLayer",
      description:
        "Inspect window.dataLayer at runtime using a headless browser. Checks if dataLayer exists, its contents (events), whether GTM and gtag are loaded, and detects suspicious patterns like dataLayer redefinition after GTM init.",
      inputSchema: checkDatalayerSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkDatalayer(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: intercept_tracking_requests
  server.registerTool(
    "intercept_tracking_requests",
    {
      title: "Intercept Tracking Requests",
      description:
        "Intercept and analyze all tracking network requests (GA4 hits, GTM, gtag) fired during page load using Puppeteer request interception. Parses GA4 /g/collect hits for event names and measurement IDs. Detects obsolete Universal Analytics hits and duplicate events.",
      inputSchema: interceptTrackingRequestsSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await interceptTrackingRequests(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: audit_tracking
  server.registerTool(
    "audit_tracking",
    {
      title: "Audit Tracking",
      description:
        "Full tracking audit: runs check_gtm_snippet, check_datalayer, and intercept_tracking_requests in parallel, then produces a unified report with a global score, severity summary, and cross-tool diagnosis.",
      inputSchema: auditTrackingSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await auditTracking(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_security_headers
  server.registerTool(
    "check_security_headers",
    {
      title: "Check Security Headers",
      description:
        "Audit HTTP security headers (HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, etc.). Returns a 0-100 score with grade (A-F), per-header analysis, and actionable recommendations. Lightweight — uses a single HTTP request, no browser needed.",
      inputSchema: checkSecurityHeadersSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkSecurityHeaders(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_hreflang
  server.registerTool(
    "check_hreflang",
    {
      title: "Check Hreflang",
      description:
        "Validate hreflang alternate language tags on a page. Checks language code validity (ISO 639-1), URL accessibility, reciprocal linking between language versions, x-default presence, canonical consistency, and language set coherence. Returns a 0-100 score with detailed per-alternate analysis.",
      inputSchema: checkHreflangSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkHreflang(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: audit_content_quality
  server.registerTool(
    "audit_content_quality",
    {
      title: "Audit Content Quality",
      description:
        "Analyze content quality of a web page: word count, readability score (multilingual), text-to-HTML ratio, heading structure, link density, media richness, and engagement signals (TOC, FAQ, CTA). Returns a 0-100 score with per-category breakdown and actionable recommendations. Does NOT check SEO meta tags — use audit_onpage for that.",
      inputSchema: auditContentQualitySchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await auditContentQuality(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_accessibility
  server.registerTool(
    "check_accessibility",
    {
      title: "Check Accessibility",
      description:
        "Run a lightweight WCAG accessibility audit on a web page. Checks images alt text, form labels, semantic structure (landmarks, lang), heading hierarchy, link text quality, viewport zoom restrictions, table structure, media controls, and ARIA usage. Returns a 0-100 score with per-category breakdown, WCAG criteria references, and actionable issues with CSS selectors. Does NOT check color contrast or keyboard navigation (requires browser rendering).",
      inputSchema: checkAccessibilitySchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkAccessibility(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: extract_images_audit
  server.registerTool(
    "extract_images_audit",
    {
      title: "Extract Images Audit",
      description:
        "Comprehensive image audit for a web page. Uses Puppeteer to detect all images (img, picture, CSS backgrounds) including lazy-loaded ones. Analyzes format (WebP/AVIF adoption), alt text quality, responsive images (srcset), sizing optimization, lazy loading correctness, LCP candidate optimization, and file sizes. Returns a 0-100 score with per-image details and actionable recommendations.",
      inputSchema: extractImagesAuditSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await extractImagesAudit(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Tool: check_consent_mode
  server.registerTool(
    "check_consent_mode",
    {
      title: "Check Consent Mode",
      description:
        "Audit Google Consent Mode v2 implementation and cookie compliance. Detects CMP vendor (Cookiebot, OneTrust, Didomi, Axeptio, etc.), verifies consent default/update configuration, checks IAB TCF API presence, analyzes GA4 hit consent signals (gcs/gcd parameters), and audits pre-consent cookie behavior. Returns a 0-100 GDPR compliance score with detailed findings.",
      inputSchema: checkConsentModeSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const result = await checkConsentMode(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}
