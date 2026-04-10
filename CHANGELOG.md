# Changelog

## [4.2.0] - 2026-04-10

### Added
- `check_security_headers` — HTTP security headers audit with 0-100 scoring (HSTS, CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP, CORP, COEP)
- `check_hreflang` — Hreflang validation with reciprocal link checking, language code validation (ISO 639-1), x-default detection, and canonical consistency
- `audit_content_quality` — Content quality analysis with multilingual readability scoring (FR/NL/EN/DE/ES/IT), text-to-HTML ratio, heading structure, link density, media richness, and engagement signals (TOC/FAQ/CTA detection)
- `check_accessibility` — Lightweight WCAG audit covering 9 categories: images, forms, semantic structure, headings, links, contrast/visuals, tables, media, ARIA usage. Multilingual generic link text detection (FR/NL/EN/DE)
- `extract_images_audit` — Puppeteer-based image audit: modern format adoption (WebP/AVIF), alt text quality, responsive images (srcset), sizing optimization, lazy loading correctness, LCP candidate analysis, file size audit
- `check_consent_mode` — Google Consent Mode v2 compliance audit: CMP detection (Cookiebot, OneTrust, Didomi, Axeptio, etc.), IAB TCF API check, consent default/update verification, GA4 gcs/gcd signal analysis, pre-consent cookie audit

### Stats
- Total tools: 23 → 29
- New tests: 76 (10 + 12 + 11 + 13 + 13 + 17)
- All tests passing, build clean
