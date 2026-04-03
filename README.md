# Fetch Crawl MCP v4.0.0

Serveur MCP (Model Context Protocol) pour fetcher, crawler et analyser des sites web. 19 outils utilisables depuis Claude Code, Claude Desktop, ou tout client MCP compatible.

## Installation

```bash
npm install
npm run build
```

Puppeteer est requis pour les outils `screenshot`, `check_performance`, `check_mobile` et le fallback anti-bot. Chromium s'installe automatiquement lors du `npm install`.

## Utilisation

### Stdio (défaut)

```bash
npm start
# ou
node build/index.js
```

### HTTP

```bash
npm run start:http
# ou
node build/index.js --http --port 3001
```

### Configuration client MCP

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

## Format de réponse standard

Tous les outils retournent un format `StandardResponse` unifié :

```typescript
{
  url: string;           // URL demandée
  finalUrl: string;      // URL finale (après redirections)
  status: number;        // Code HTTP
  score?: number;        // Score 0-100 (si applicable)
  summary: string;       // Résumé en une phrase
  issues: ToolIssue[];   // Problèmes détectés (severity, element, message, evidence?)
  recommendations: [];   // Recommandations d'amélioration
  meta: {
    fetchedWith: "fetch" | "puppeteer";
    fallbackUsed: boolean;
    partial: boolean;     // true si le contenu a été tronqué (> 5MB)
    durationMs: number;
    timestamp: string;
  };
  data: {};              // Données spécifiques à l'outil
}
```

## Anti-Bot Detection

Le fetcher intègre un système de détection anti-bot avancé :

- **Détection automatique** : Cloudflare, DataDome, Akamai, Sucuri, PerimeterX
- **Stealth Puppeteer** : patches navigator.webdriver, plugins, languages, platform, hardwareConcurrency, deviceMemory, chrome.runtime, Notification permissions, WebGL renderer
- **Fallback propre** : si le site reste bloqué même avec Puppeteer, retour d'un status 403 avec info `antiBot: { blocked, provider, confidence }` au lieu d'un crash
- **Launch args optimisés** : `--disable-blink-features=AutomationControlled`, `--disable-features=IsolateOrigins,site-per-process`, `--window-size=1920,1080`

## Outils (19)

### Fetching & Crawling

#### `fetch_page`

Récupère une page web et retourne son contenu dans le format spécifié.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à fetcher |
| `format` | `"html"` \| `"text"` \| `"markdown"` | `"markdown"` | Format de sortie |
| `headers` | object | — | Headers HTTP personnalisés |

**Retour** : contenu de la page, titre, description, type de contenu.

---

#### `crawl_site`

Crawle un site récursivement en suivant les liens internes.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL de départ |
| `maxDepth` | number (0–10) | `2` | Profondeur max (0 = page de départ uniquement) |
| `maxPages` | number (1–500) | `50` | Nombre max de pages |
| `delay` | number (0–10000) | `300` | Délai en ms entre les requêtes (±30% jitter) |
| `concurrency` | number (1–10) | `3` | Pages fetchées en parallèle |
| `respectRobotsTxt` | boolean | `true` | Respecter robots.txt et Crawl-delay |
| `includePattern` | string | — | Regex : ne crawler que les URLs matchant |
| `excludePattern` | string | — | Regex : exclure les URLs matchant |

**Score** : basé sur le ratio de pages en erreur (status >= 400).

**Timeout** : le crawl s'arrête proprement après 5 minutes (`abortedEarly: true`).

**Retour** : liste des pages crawlées avec titre, status, profondeur, liens trouvés + `crawlStats: { startedAt, finishedAt, durationSeconds, pagesPerSecond, abortedEarly, abortReason }`.

---

#### `screenshot`

Capture une screenshot d'une page web via Puppeteer. Supporte PNG/JPEG, viewport personnalisé, capture pleine page, attente de sélecteur CSS, et fermeture des bannières cookies.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à capturer |
| `width` | number (320–3840) | `1280` | Largeur du viewport |
| `height` | number (240–2160) | `800` | Hauteur du viewport |
| `fullPage` | boolean | `false` | Capturer toute la page scrollable |
| `format` | `"png"` \| `"jpeg"` | `"png"` | Format d'image |
| `quality` | number (1–100) | `80` | Qualité (jpeg uniquement) |
| `waitForSelector` | string | — | Sélecteur CSS à attendre avant capture |
| `dismissCookies` | boolean | `false` | Tenter de fermer les bannières cookies |

**Robustesse** : timeout global Puppeteer, auto-recompression JPEG si fullPage > 900KB, retour d'erreur propre en cas d'échec.

---

### SEO Audit

#### `audit_onpage`

Audit technique on-page complet : title, meta description, canonical, robots, lang, hiérarchie H1-H6, attributs alt des images, Open Graph, Twitter Card, JSON-LD.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à auditer |

**Score** : 0-100 basé sur les issues (error = -15pts, warning = -5pts).

**Retour** : données SEO complètes dans `data{}`, issues avec severity, recommandations.

---

#### `check_indexability`

Vérifie si une page est indexable par les moteurs de recherche.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL de la page |

**Analyses** :
- Status HTTP
- Meta robots (noindex, nofollow, none, noarchive, nosnippet)
- X-Robots-Tag HTTP header
- Canonical (auto-référençante ? cross-domain ?)
- Hreflang / rel alternate
- Présence dans le sitemap

**Score** : -40 noindex, -30 status != 200, -20 canonical elsewhere, -10 absent du sitemap.

**Retour** : verdict `indexable: boolean` avec raison détaillée.

---

#### `check_structured_data`

Extrait et valide les données structurées d'une page.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à analyser |

**Extraction** :
- **JSON-LD** (incluant `@graph`) avec validation par type : Product, Organization, LocalBusiness, BreadcrumbList, Article, NewsArticle, BlogPosting
- **Microdata** (itemscope/itemtype/itemprop)
- **Open Graph** (og:*)
- **Twitter Card** (twitter:*)

**Score** : -20 si pas de JSON-LD, -10 si pas d'OG, -10 si pas de Twitter Card, -15 par schema invalide.

---

#### `check_robots_txt`

Analyse le robots.txt d'un site et vérifie la cohérence des sitemaps.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL du site |

**Analyses** :
- Parse complet par User-Agent (Allow + Disallow)
- Crawl-delay
- Sitemaps déclarés vs réellement accessibles
- Détection de sitemaps non déclarés (/sitemap.xml, /1_index_sitemap.xml)

**Score** : -30 si absent, -15 si aucun sitemap déclaré, -10 par sitemap inaccessible ou non déclaré.

---

### Content Extraction

#### `extract_content`

Extrait le contenu structuré d'une page : headings, liens, images, texte brut avec statistiques.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL source |

**Retour** : titre, description, lang, headings, liens (max 100), images (max 50), contenu texte (max 10000 chars), stats.

---

#### `extract_links`

Extrait tous les liens d'une page avec filtrage par type.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL source |
| `type` | `"all"` \| `"internal"` \| `"external"` | `"all"` | Filtrer par type |

**Retour** : liens uniques avec href, texte, rel, isInternal, isNofollow.

---

#### `extract_with_schema`

Extraction structurée basée sur des sélecteurs CSS configurables, avec presets intégrés.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL source |
| `schema` | object | — | Schema d'extraction (voir ci-dessous) |
| `fallbackSelectors` | object | — | Sélecteurs de fallback si le principal échoue |
| `preset` | `"ecommerce-product"` \| `"article"` \| `"local-business"` \| `"recipe"` | — | Preset intégré |

**Schema** : chaque clé est un champ, la valeur est `{ selector, attribute?, multiple?, transform? }`.

```json
{
  "productName": { "selector": "h1.product-title", "transform": "text" },
  "price": { "selector": ".product-price .current", "transform": "number" },
  "images": { "selector": ".product-gallery img", "attribute": "src", "multiple": true },
  "description": { "selector": ".product-description", "transform": "html" }
}
```

**Transforms** : `text` (innerText), `html` (innerHTML), `number` (parseFloat), `trim` (text trimmed), `href` (attribut href).

**Presets intégrés** :
- `ecommerce-product` : productName, price, oldPrice, currency, images, description, sku, brand, availability, breadcrumb, reviewsCount
- `article` : title, author, publishDate, content, categories, tags, readingTime (auto-calculé)
- `local-business` : name, address, phone, email, hours, coordinates, rating, reviewCount
- `recipe` : title, prepTime, cookTime, servings, ingredients, instructions, calories, image

Si `preset` ET `schema` sont fournis, le schema override les champs du preset.

**Score** : `(fieldsFound / fieldsTotal) * 100`.

**Retour** : `data.extracted` (données), `fieldsFound`, `fieldsTotal`, `fieldsMissing`, `usedFallback`, `preset`.

---

#### `parse_sitemap`

Parse un sitemap.xml (ou le détecte automatiquement). Supporte les sitemap index.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL du sitemap ou racine du site |

**Score** : -20 par erreur de parsing, -5 si tronqué.

**Retour** : entrées avec loc, lastmod, changefreq, priority (max 500).

---

### Technical Checks

#### `check_links`

Vérifie tous les liens d'une page pour détecter les liens cassés (404, timeout, erreurs).

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à vérifier |
| `timeout` | number (1000–30000) | `5000` | Timeout par lien |
| `concurrency` | number (1–20) | `3` | Liens vérifiés en parallèle |
| `delay` | number (0–5000) | `200` | Délai entre les batchs (±30% jitter) |

**Score** : basé sur le ratio liens cassés / total.

---

#### `check_redirect_chain`

Suit la chaîne de redirections hop par hop.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à suivre |
| `maxRedirects` | number (1–30) | `10` | Nombre max de redirections |

**Score** : 100 si 0-1 redirect, 80 si 2-3, 60 si > 3, 0 si boucle.

**Détections** : boucles de redirection, chaînes longues (> 3), upgrades HTTP → HTTPS.

---

#### `check_performance`

Mesure les métriques de performance via Puppeteer avec profil mobile ou desktop.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à auditer |
| `device` | `"mobile"` \| `"desktop"` | `"mobile"` | Profil (mobile: 375x812 + throttling, desktop: 1280x800) |

**Métriques** : TTFB, FCP, LCP, DOM Content Loaded, Fully Loaded, requêtes réseau, bytes transférés, ressources par type.

**Score (0-100)** : LCP (40%), FCP (35%), TTFB (25%) selon les seuils Web Vitals.

---

#### `check_mobile`

Audit de compatibilité mobile via Puppeteer avec viewport iPhone (375x812).

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL à vérifier |

**Vérifications** : meta viewport, scroll horizontal, fonts < 12px, tap targets < 48px.

**Score** : -30 si pas de viewport meta, -10 si scroll horizontal, -5 par tranche de 10 tap targets trop petits.

**Retour** : analyse + screenshot JPEG mobile.

---

### Multi-Page & Comparison

#### `compare_pages`

Compare deux pages web côte à côte sur 12 critères SEO.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `urlA` | string | *requis* | Première URL |
| `urlB` | string | *requis* | Deuxième URL |
| `includeScreenshot` | boolean | `false` | Capturer une screenshot de chaque page |

**Critères comparés** : title, meta description, H1, heading structure, word count, internal links, external links, images alt, Open Graph, Twitter Card, JSON-LD, canonical.

**Retour** : score individuel par page (0-100), tableau comparatif avec winner par critère, screenshots optionnels.

---

#### `audit_site_batch`

Audit batch de multiples pages d'un site avec agrégation des résultats.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL du site |
| `source` | `"sitemap"` \| `"crawl"` \| `"urls"` | `"sitemap"` | Source des URLs |
| `urls` | string[] | — | Liste d'URLs (si source = "urls") |
| `limit` | number (1–200) | `30` | Nombre max de pages |
| `concurrency` | number (1–5) | `2` | Pages auditées en parallèle |
| `delay` | number (0–5000) | `500` | Délai entre les batchs |

**Timeout** : le batch s'arrête proprement après 5 minutes avec `meta.partial = true`.

**Fallback sitemap** : si `/sitemap.xml` ne retourne aucune URL, essaie automatiquement `/1_index_sitemap.xml`.

**Agrégation** :
- Score moyen et médiane
- Distribution (excellent / bon / moyen / mauvais)
- Top 10 problèmes triés par fréquence
- Quick wins (pages > 60 pts avec 1-2 fixes faciles)
- Pages critiques (les 10 pires scores)
- `executionStats`: startedAt, finishedAt, durationSeconds, pagesPerSecond, timedOut

---

#### `detect_orphan_pages`

Détecte les pages orphelines en croisant le sitemap, le crawl et le graphe de liens internes.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL du site |
| `maxCrawlPages` | number (1–300) | `100` | Pages crawlées pour le graphe |
| `crawlDepth` | number (1–5) | `3` | Profondeur de crawl |
| `concurrency` | number (1–5) | `3` | Pages en parallèle |
| `delay` | number (0–5000) | `300` | Délai entre batches |

**Classification** (6 catégories) :
- `orphan_in_sitemap` : dans le sitemap, 0 lien interne (critique)
- `orphan_not_in_sitemap` : hors sitemap, 0-1 lien interne (isolée)
- `sitemap_only` : dans le sitemap, non atteinte par le crawl
- `crawl_only` : trouvée par le crawl, absente du sitemap
- `deep_page` : atteinte uniquement à profondeur >= 4
- `well_linked` : sitemap + crawl + >= 2 liens entrants

**Score** : -2/orpheline (max -40), -1/sitemap_only (max -20), -1/crawl_only (max -15), -0.5/deep_page (max -10), -15 si cohérence < 50%.

**Retour** : stats (overlap sitemap/crawl), catégories avec exemples, top 20 pages hub (plus de liens entrants), top 10 orphelines critiques.

---

#### `detect_duplicate_content`

Détecte les contenus dupliqués et quasi-dupliqués sur un site.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *requis* | URL du site |
| `source` | `"sitemap"` \| `"crawl"` \| `"urls"` | `"crawl"` | Source des URLs |
| `urls` | string[] | — | Liste d'URLs (si source = "urls") |
| `limit` | number (1–200) | `50` | Nombre max de pages |
| `concurrency` | number (1–5) | `3` | Pages en parallèle |
| `delay` | number (0–5000) | `300` | Délai entre batches |
| `similarityThreshold` | number (0–1) | `0.8` | Seuil de similarité pour near-duplicates |

**Détection** :
- **Exact duplicates** : titles, descriptions, H1 identiques (groupés par cluster)
- **Near-duplicates** : titles et contenus quasi-identiques (similarité mots communs / mots uniques > seuil)
- Optimisation : regroupement par les 3 premiers mots pour éviter O(n²)

**Score** : -5 par cluster exact (max -40), -2 par cluster near-duplicate (max -30).

**Retour** : `exactDuplicates[]`, `nearDuplicates[]`, `uniquePages`, stats avec `mostDuplicatedValue`.

---

## Architecture

```
src/
├── index.ts                          # Entry point (stdio + HTTP)
├── server.ts                         # MCP server, tool registration
├── tools/
│   ├── fetch-page.ts                 # fetch_page
│   ├── crawl-site.ts                 # crawl_site
│   ├── screenshot.ts                 # screenshot
│   ├── analyze-seo.ts               # audit_onpage
│   ├── check-indexability.ts         # check_indexability
│   ├── check-structured-data.ts     # check_structured_data
│   ├── check-robots-txt.ts          # check_robots_txt
│   ├── extract-content.ts           # extract_content
│   ├── extract-links.ts             # extract_links
│   ├── extract-with-schema.ts       # extract_with_schema
│   ├── parse-sitemap.ts             # parse_sitemap
│   ├── check-links.ts              # check_links
│   ├── check-redirect-chain.ts     # check_redirect_chain
│   ├── check-performance.ts        # check_performance
│   ├── check-mobile.ts             # check_mobile
│   ├── compare-pages.ts            # compare_pages
│   ├── audit-site-batch.ts         # audit_site_batch
│   ├── detect-orphan-pages.ts      # detect_orphan_pages
│   └── detect-duplicate-content.ts # detect_duplicate_content
└── utils/
    ├── fetcher.ts                    # HTTP fetch + stealth Puppeteer + anti-bot detection
    ├── html-parser.ts               # Cheerio-based HTML extraction
    ├── robots-parser.ts             # robots.txt parser
    ├── url-utils.ts                 # URL normalization utilities
    └── response.ts                  # StandardResponse, ToolIssue, ToolMeta, helpers
```

## Stack technique

- **Runtime** : Node.js (ES2022)
- **Langage** : TypeScript (strict)
- **MCP SDK** : @modelcontextprotocol/sdk
- **HTML parsing** : Cheerio
- **Browser automation** : Puppeteer (stealth mode)
- **Validation** : Zod
- **Transport** : stdio (défaut) ou HTTP (Express + StreamableHTTPServerTransport)

## Déploiement Docker

### Quick start

```bash
./deploy.sh
```

### Manuel

```bash
# Build TypeScript
npm run build

# Build image Docker
docker build -t fetch-crawl-mcp:latest .

# Lancer avec docker compose
docker compose up -d

# Vérifier
curl http://localhost:3001/health
```

### Configuration Docker

Le `Dockerfile` utilise `node:22-slim` avec Chromium préinstallé pour Puppeteer. L'image finale ne contient que `build/` et les dépendances de production.

| Variable d'environnement | Défaut | Description |
|--------------------------|--------|-------------|
| `NODE_ENV` | `production` | Environnement Node.js |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chemin vers Chromium dans le container |

Ressources par défaut (docker-compose) : 2 Go RAM, 1.5 CPU.

### Configuration client MCP (HTTP distant)

```json
{
  "mcpServers": {
    "fetch-crawl-mcp": {
      "url": "http://YOUR_SERVER:3001/mcp"
    }
  }
}
```

---

## Développement

```bash
npm run dev        # Watch mode avec tsx
npm run build      # Build TypeScript
npm start          # Serveur stdio
npm run start:http # Serveur HTTP (port 3001)
```

## Licence

MIT
