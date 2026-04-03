# fetch-crawl-mcp

MCP server for fetching, crawling, and analyzing websites. Provides 14 tools for web content extraction, SEO auditing, performance measurement, and more.

## Installation

```bash
npm install
npm run build
```

## Usage

### Stdio (default)

```bash
npm start
# or
node build/index.js
```

### HTTP

```bash
npm run start:http
# or
node build/index.js --http --port 3001
```

### MCP client configuration

```json
{
  "mcpServers": {
    "fetch-crawl-mcp": {
      "command": "node",
      "args": ["/path/to/fetch-crawl-mcp/build/index.js"]
    }
  }
}
```

## Tools (14)

### 1. `fetch_page`

Fetch a web page and return its content in the specified format.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to fetch |
| `format` | `"html"` \| `"text"` \| `"markdown"` | `"markdown"` | Output format |
| `headers` | object | — | Optional custom HTTP headers |

### 2. `crawl_site`

Crawl a website recursively starting from a URL. Follows internal links up to a specified depth and max pages.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The starting URL to crawl |
| `maxDepth` | number (0–10) | `2` | Maximum crawl depth (0 = starting page only) |
| `maxPages` | number (1–200) | `50` | Maximum number of pages to crawl |
| `delay` | number (0–10000) | `300` | Base delay in ms between requests (±30% jitter) |
| `concurrency` | number (1–10) | `3` | Pages to fetch in parallel |
| `respectRobotsTxt` | boolean | `true` | Respect robots.txt rules and Crawl-delay |
| `includePattern` | string | — | Regex: only crawl URLs matching this pattern |
| `excludePattern` | string | — | Regex: skip URLs matching this pattern |

### 3. `extract_content`

Extract structured content from a web page: headings, paragraphs, images, links, and plain text with statistics.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to extract content from |

### 4. `extract_links`

Extract all links from a web page. Can filter by internal, external, or all links.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to extract links from |
| `type` | `"all"` \| `"internal"` \| `"external"` | `"all"` | Filter links by type |

### 5. `audit_onpage`

Technical on-page HTML audit. Checks title tag, meta description, canonical, robots, lang, heading hierarchy, image alt attributes, Open Graph, Twitter Card, and JSON-LD structured data.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to audit |

### 6. `parse_sitemap`

Parse a sitemap.xml file (or auto-detect it from a website root). Supports sitemap index files.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The sitemap.xml URL or website root URL |

### 7. `check_links`

Check all links on a web page for broken links (404, timeout, connection errors).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to check links on |
| `timeout` | number (1000–30000) | `5000` | Timeout in ms for each link check |
| `concurrency` | number (1–20) | `3` | Number of links to check simultaneously |
| `delay` | number (0–5000) | `200` | Base delay in ms between batches (±30% jitter) |

### 8. `screenshot`

Capture a screenshot of a web page using a headless browser. Supports PNG/JPEG, custom viewport, full-page capture, waiting for a CSS selector, and cookie consent dismissal.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to capture |
| `width` | number (320–3840) | `1280` | Viewport width in pixels |
| `height` | number (240–2160) | `800` | Viewport height in pixels |
| `fullPage` | boolean | `false` | Capture the full scrollable page |
| `format` | `"png"` \| `"jpeg"` | `"png"` | Image format |
| `quality` | number (1–100) | `80` | Image quality (only used for jpeg) |
| `waitForSelector` | string | — | CSS selector to wait for before capturing |
| `dismissCookies` | boolean | `false` | Attempt to dismiss cookie consent banners before capturing |

### 9. `check_performance`

Measure web page performance metrics using a headless browser. Supports mobile (with network throttling) and desktop profiles.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to audit |
| `device` | `"mobile"` \| `"desktop"` | `"mobile"` | Device profile (mobile: 375x812 + throttled, desktop: 1280x800) |

**Metrics returned:** TTFB, FCP, LCP, DOM Content Loaded, Fully Loaded, total requests, total bytes transferred, resource counts by type (scripts, styles, images, fonts, other).

**Scoring (0–100):** Based on Web Vitals thresholds — LCP (40% weight), FCP (35%), TTFB (25%). Issues are returned with `error`/`warning`/`info` severity.

### 10. `check_redirect_chain`

Follow the redirect chain of a URL hop by hop. Detects redirect loops, long chains, and HTTP-to-HTTPS upgrades.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to follow redirects for |
| `maxRedirects` | number (1–30) | `10` | Maximum number of redirects to follow |

**Returns:** `chain[]` (each hop with url, status, Location header, Server header), `totalRedirects`, `finalUrl`, `finalStatus`, `hasLoop`, `issues[]`.

### 11. `check_mobile`

Audit a web page for mobile-friendliness using a headless browser with iPhone viewport (375x812) and mobile User-Agent.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to check |

**Checks performed:**
- Presence of `<meta name="viewport">` and its content
- Horizontal scroll detection (content wider than viewport)
- Small font sizes (elements with font-size < 12px)
- Small tap targets (links/buttons smaller than 48x48px)

**Returns:** Analysis results, `issues[]` with severity, and a mobile JPEG screenshot.

### 12. `check_structured_data`

Extract and validate structured data from a web page.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | The URL to extract structured data from |

**Extracts:**
- **JSON-LD** blocks (including `@graph` arrays) with type-specific validation:
  - `Product` — name, image, description, offers, offers.price, offers.priceCurrency
  - `Organization` / `LocalBusiness` — name, url, logo
  - `BreadcrumbList` — itemListElement
  - `Article` / `NewsArticle` / `BlogPosting` — headline, datePublished, author
- **Microdata** (elements with itemscope/itemtype/itemprop)
- **Open Graph** meta tags (og:*)
- **Twitter Card** meta tags (twitter:*)

**Returns:** `jsonLd[]`, `microdata[]`, `openGraph{}`, `twitterCard{}`, `issues[]`, `summary { totalSchemas, validCount, invalidCount }`.

## Tool categories

| Category | Tools |
|----------|-------|
| **Content** | `fetch_page`, `extract_content`, `extract_links` |
| **Crawling** | `crawl_site`, `parse_sitemap` |
| **SEO** | `audit_onpage`, `check_structured_data` |
| **Technical** | `check_links`, `check_redirect_chain` |
| **Performance** | `check_performance` |
| **Mobile** | `check_mobile` |
| **Visual** | `screenshot` |

## Development

```bash
npm run dev      # Watch mode with tsx
npm run build    # Build TypeScript
npm start        # Run built server (stdio)
npm run start:http  # Run built server (HTTP)
```

## License

MIT
