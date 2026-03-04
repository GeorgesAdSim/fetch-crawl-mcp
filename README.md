# Fetch Crawl MCP

Serveur MCP (Model Context Protocol) pour fetcher, crawler et analyser des sites web. Fournit 8 outils utilisables depuis Claude Code, Claude Desktop, ou tout client MCP compatible.

## Installation

```bash
npm install
npm run build
```

Puppeteer est requis pour l'outil `screenshot` et le fallback anti-bot. Chromium s'installe automatiquement lors du `npm install`.

## Utilisation

### Mode local (stdio) - Claude Code

Le fichier `.mcp.json` est deja configure a la racine du projet :

```bash
npm run build
```

Claude Code detectera automatiquement le serveur. Ajout manuel possible :

```bash
claude mcp add fetch-crawl -s project -- node ./build/index.js
```

### Mode HTTP (deploiement distant)

```bash
# Port par defaut (3001)
npm run start:http

# Port personnalise
node build/index.js --http --port 8080
```

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/mcp` | POST | Endpoint MCP (Streamable HTTP) |
| `/health` | GET | Health check |

```bash
claude mcp add fetch-crawl -t http http://localhost:3001/mcp
```

### Mode developpement

```bash
npm run dev
```

---

## Protections integrees

### Anti-bot

Toutes les requetes HTTP utilisent des protections pour eviter les blocages :

- **Rotation de User-Agent** : 7 User-Agents reels (Chrome, Firefox, Safari, Edge) tires au hasard a chaque requete
- **Headers realistes** : Sec-Fetch-Dest, Sec-Fetch-Mode, Accept-Encoding, etc. identiques a un vrai navigateur
- **Fallback Puppeteer automatique** : si une page renvoie un 403/503 avec signature Cloudflare ou anti-bot, le fetcher relance la requete via un navigateur headless complet (avec masquage du flag webdriver)
- **Fallback dernier recours** : si le fetch echoue completement (erreur reseau), Puppeteer est tente automatiquement

### Throttling

- **Jitter aleatoire** : tous les delais sont varies de ±30% pour ne pas ressembler a un robot avec un timing fixe
- **Detection 429** : si un serveur repond 429 (Too Many Requests), le crawler attend le temps indique dans `Retry-After` puis retente
- **robots.txt** : le crawler parse automatiquement robots.txt et respecte les regles Disallow et Crawl-delay

### checkUrl ameliore

- Si un serveur bloque les requetes HEAD (405/403), le verificateur de liens retente automatiquement en GET

---

## Outils

### `fetch_page`

Recupere une page web et retourne son contenu dans le format choisi.

| Parametre | Type | Defaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *(requis)* | URL a fetcher |
| `format` | `"html"` \| `"text"` \| `"markdown"` | `"markdown"` | Format de sortie |
| `headers` | object | - | Headers HTTP personnalises |

Retourne : contenu, status HTTP, URL finale, titre, description. Si la page est bloquee par un anti-bot, le fallback Puppeteer est utilise automatiquement.

---

### `crawl_site`

Crawle un site recursivement en suivant les liens internes. Utilise un pool de requetes concurrentes avec throttling.

| Parametre | Type | Defaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *(requis)* | URL de depart |
| `maxDepth` | number | `2` | Profondeur max (0 = page de depart uniquement) |
| `maxPages` | number | `50` | Nombre max de pages a crawler |
| `delay` | number | `300` | Delai de base en ms entre les requetes (jitter ±30% applique) |
| `concurrency` | number | `3` | Nombre de pages fetchees en parallele |
| `respectRobotsTxt` | boolean | `true` | Respecter robots.txt (Disallow + Crawl-delay) |
| `includePattern` | string | - | Regex : ne crawler que les URLs correspondantes |
| `excludePattern` | string | - | Regex : exclure les URLs correspondantes |

Retourne : liste des pages avec URL, titre, status, profondeur, liens trouves, methode de fetch utilisee (fetch ou puppeteer), infos robots.txt.

---

### `extract_content`

Extrait le contenu structure d'une page web.

| Parametre | Type | Description |
|-----------|------|-------------|
| `url` | string | URL a analyser |

Retourne : titre, description, headings (h1-h6), liens (100 premiers), images (50 premieres), contenu texte, statistiques.

---

### `extract_links`

Extrait tous les liens d'une page avec leurs attributs.

| Parametre | Type | Defaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *(requis)* | URL a analyser |
| `type` | `"all"` \| `"internal"` \| `"external"` | `"all"` | Filtre par type |

Retourne : liens dedupliques avec texte d'ancrage, URL cible, rel, nofollow.

---

### `analyze_seo`

Analyse SEO complete d'une page web avec score et recommandations.

| Parametre | Type | Description |
|-----------|------|-------------|
| `url` | string | URL a analyser |

Retourne :
- **Title** : contenu et longueur
- **Meta description** : contenu et longueur
- **Canonical URL**
- **Meta robots**
- **Open Graph** : tous les tags og:*
- **Twitter Card** : tous les tags twitter:*
- **Headings** : structure h1-h6 avec contenu
- **Images** : total, sans alt, URLs concernees
- **Liens** : internes, externes, nofollow
- **Donnees structurees** : JSON-LD detecte
- **Score SEO** : 0-100 avec liste de problemes (error/warning/info)

---

### `parse_sitemap`

Parse un fichier sitemap.xml (ou le detecte automatiquement depuis l'URL du site).

| Parametre | Type | Description |
|-----------|------|-------------|
| `url` | string | URL du sitemap.xml ou du site (auto-detection de /sitemap.xml) |

Retourne : liste des URLs avec lastmod, changefreq, priority. Supporte les sitemap index (recursif).

---

### `check_links`

Verifie tous les liens d'une page pour detecter les liens casses. Throttling integre.

| Parametre | Type | Defaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *(requis)* | URL a verifier |
| `timeout` | number | `5000` | Timeout par lien (ms) |
| `concurrency` | number | `3` | Nombre de liens verifies simultanement |
| `delay` | number | `200` | Delai de base en ms entre chaque batch (jitter ±30% applique) |

Retourne : liens casses (404, timeout, erreur), liens rediriges, liens OK avec status codes.

---

### `screenshot`

Capture une screenshot d'une page via un navigateur headless (Puppeteer).

| Parametre | Type | Defaut | Description |
|-----------|------|--------|-------------|
| `url` | string | *(requis)* | URL a capturer |
| `width` | number | `1280` | Largeur du viewport (px) |
| `height` | number | `800` | Hauteur du viewport (px) |
| `fullPage` | boolean | `false` | Capturer la page entiere (scroll) |

Retourne : image PNG en base64.

---

## Architecture

```
src/
├── index.ts               # Entry point (stdio / HTTP)
├── server.ts              # Creation du serveur MCP + enregistrement des outils
├── tools/
│   ├── fetch-page.ts      # Fetch une page (HTML/texte/markdown)
│   ├── crawl-site.ts      # Crawl concurrent BFS + robots.txt
│   ├── extract-content.ts # Extraction structuree
│   ├── extract-links.ts   # Extraction de liens
│   ├── analyze-seo.ts     # Analyse SEO
│   ├── parse-sitemap.ts   # Parsing sitemap.xml
│   ├── check-links.ts     # Detection liens casses
│   └── screenshot.ts      # Capture d'ecran (Puppeteer)
└── utils/
    ├── fetcher.ts         # Client HTTP (UA rotation, headers realistes, Puppeteer fallback)
    ├── robots-parser.ts   # Parser robots.txt (Disallow, Crawl-delay, Sitemap)
    ├── html-parser.ts     # Helpers Cheerio (metadata, liens, images, headings)
    └── url-utils.ts       # Normalisation et resolution d'URLs
```

## Stack technique

- **MCP SDK** : `@modelcontextprotocol/sdk` v1.x
- **HTML parsing** : Cheerio
- **Screenshots + anti-bot fallback** : Puppeteer
- **HTTP server** : Express (mode distant)
- **Validation** : Zod
- **Runtime** : Node.js (ESM)

## Licence

MIT
