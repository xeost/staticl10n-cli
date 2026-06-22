# staticl10n

> **Static Localization CLI** — Capture any website as a static mirror and translate it into multiple languages using local AI (Ollama).

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## What is staticl10n?

`staticl10n` is a command-line tool that:

1. **Crawls** a live website and downloads all its pages and assets as a fully self-contained static site.
2. **Translates** the captured HTML into multiple target languages using a locally-running Ollama model (no cloud API keys required).
3. **Personalizes** the output — remove tracking scripts, inject banners, replace text — before and after translation.
4. **Monitors** the original site for content changes and alerts you when pages need re-translation.

The result is one independent static directory per language, ready to be deployed to any static hosting provider (Netlify, Vercel, S3, Cloudflare Pages, etc.).

---

## Key Features

- **Works with any website** — generic adapter for static-site generators (Hugo, Astro, VitePress, Jekyll) plus a specialized Next.js adapter that handles React hydration.
- **Local AI translation** via [Ollama](https://ollama.com) — your data never leaves your machine.
- **Translation memory cache** — previously translated fragments are reused from a local SQLite database, saving time and tokens.
- **Structural integrity verification** — translated HTML is validated to ensure tags and attributes are preserved; failed checks trigger automatic retries.
- **Runtime patch for Next.js** (`translations.js`) — a `MutationObserver`-based script that re-applies translations after React rehydration, with anti-flicker support.
- **SEO-ready output** — `<html lang>`, `<title>`, meta description, Open Graph tags, Twitter Card tags, JSON-LD structured data, and `hreflang` alternate links are all translated and injected.
- **Redirect detection** — HTTP 3xx redirects are automatically detected during the crawl, saved to a hosting-agnostic `redirects.json`, and a `_redirects` file (Cloudflare Pages / Netlify format) is generated in every output directory.
- **Personalization engine** — five rule types (`remove_element`, `remove_attribute`, `replace_text`, `inject_html`, `add_attribute`) applied pre- or post-translation.
- **Cron-friendly monitoring** — `staticl10n check <slug>` runs non-interactively and writes results to a log file.
- **Resume-safe** — every operation is saved atomically to SQLite; interrupted runs can be resumed without re-downloading.

---

## System Requirements

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | 20 LTS or later | Uses native `fetch`, ESM modules |
| **pnpm** | 8 or later | `npm install -g pnpm` |
| **Playwright browsers** | Chromium | Installed automatically via `pnpm exec playwright install chromium` |
| **Ollama** | Latest | [https://ollama.com/download](https://ollama.com/download) |
| **A translation model** | e.g. `gemma4`, `gemma3` | `ollama pull gemma4` |

### Install Ollama

```bash
# macOS
brew install ollama
ollama serve          # starts the Ollama server on http://localhost:11434

# Pull a recommended translation model
ollama pull gemma4
# or a smaller model for faster translation:
ollama pull gemma3:4b
```

---

## Installation

### From source (recommended during development)

```bash
git clone https://github.com/xeost/staticl10n-cli.git
cd staticl10n-cli

pnpm install

# Install Playwright's Chromium browser
pnpm exec playwright install chromium

# Run directly with tsx (no build step needed)
pnpm dev
```

### Global install after build

```bash
pnpm build
pnpm link --global

# Now available anywhere as:
staticl10n
```

---

## Quick Start

### 1. Start the interactive CLI

```bash
pnpm dev
# or, after global install:
staticl10n
```

You will see the main menu:

```
  ╔═══════════════════════════════════════╗
  ║         staticl10n  v0.1.0           ║
  ║   Static Localization CLI Tool       ║
  ╚═══════════════════════════════════════╝

? Main Menu
  ❯ Manage projects
    Select active project  [no project selected]
    ──────────────────────────────────────────
    Exit
```

### 2. Create a project

Go to **Manage projects → Create new project** and fill in:

- **Project name** — e.g. `My Company Website`
- **Source site URL** — e.g. `https://example.com`
- **Target languages** — e.g. `es,fr,de`
- **Target URLs** — e.g. `es:https://es.example.com,fr:https://fr.example.com,de:https://de.example.com`
- **Site type** — `generic` or `nextjs`
- **Output base directory** — absolute path where static files will be saved, e.g. `/data/my-project`

The project config is saved to `projects/<slug>/config.json`. Edit it directly or use **Edit project config** to open it in `$EDITOR`.

### 3. Run the workflow

Select the project as active, then execute each stage in order:

```
Stage 1: Capture
  → Detect URLs (crawler)       # discovers all pages + detects redirects
  → Capture pending pages       # downloads HTML + assets, writes _redirects
  → Apply pre-personalization   # removes analytics, cookie banners, etc.

Stage 2: Translation
  → Translate all captured pages  # _redirects is copied to each language dir

Stage 3: Post-Personalization
  → Apply post-personalization rules  # injects your banners, replaces copyright, etc.

Stage 4: Monitoring  (ongoing)
  → Check site for changes
```

---

## Single-Page Test Mode

Before processing an entire site, use the **⚡ Test: process single page** option to verify that the full pipeline works correctly on a single URL. This is especially useful for large sites where a full crawl could take a very long time.

### How to access it

From the main interactive menu, with a project already selected:

```
? Main Menu
  ...
  ─────── Active project ───────
  View project status
  Stage 1: Capture
  Stage 2: Translation
  Stage 3: Post-Personalization
  Stage 4: Monitoring
  ───────────────────────────────
❯ ⚡ Test: process single page
```

### What it does

The test wizard asks three questions and then runs:

1. **URL to test** — any page from the site (defaults to the project's base URL). The URL does not need to have been crawled first; it is inserted into the database automatically.
2. **Target languages** — which of the configured languages to translate into (all pre-selected).
3. **Stages to run** — individual stages can be toggled on/off:

| Stage | What runs |
|---|---|
| **Stage 1: Capture** | Opens the page with Playwright, applies the site adapter, downloads assets, saves to `original/` |
| **Stage 1b: Pre-personalization** | Applies `preTranslation` rules to the captured HTML (remove trackers, cookie banners, etc.) |
| **Stage 2: Translation** | Extracts translatable fragments, queries Ollama, injects translations into each language directory |
| **Stage 3: Post-personalization** | Applies `postTranslation` rules to the translated output (inject banners, replace text, etc.) |

### Example output

```
  ⚡ Single-Page Test Mode
  Runs the full pipeline on a single URL so you can verify the output
  without processing the whole site.

? URL to test: https://example.com/about
? Languages to translate into: es, fr
? Which stages to run: Stage 1, Stage 1b, Stage 2, Stage 3

  ✔ [1/4] Captured → /data/my-project/original/about/index.html
  ✔ [1b]  Pre-personalization done — 1 page, rules: Remove Analytics:3
  ✔ [2/4] Translation done — cache hits: 0, misses: 42
         [es] → /data/my-project/es/about/index.html
         [fr] → /data/my-project/fr/about/index.html
  ✔ [3/4] Post-personalization done — 3 file(s) in: original, es, fr

  Test Summary
  ─────────────────────────────────────────
  Stage 1 : Capture                  ✓ ok
  Stage 1b: Pre-personalization      ✓ ok
  Stage 2 : Translation              ✓ ok
  Stage 3 : Post-personalization     ✓ ok

  Output location:
    original/  : /data/my-project/original/about/index.html
    [es    ]:    /data/my-project/es/about/index.html
    [fr    ]:    /data/my-project/fr/about/index.html

  Tip: open the translated HTML file in a browser to verify the output.
```

### Recommended test workflow

1. Create the project and set a short `delayMs` (e.g. `500`) in the config for testing.
2. Run **⚡ Test** on the home page (`/`) first — this is usually the most complex page.
3. Check the output HTML in a browser and verify:
   - Text is translated correctly.
   - Images and links still work (relative paths resolved).
   - Personalization rules applied as expected.
   - For Next.js sites: the `translations.js` patch is present and the page does not flicker.
4. Adjust `config.json` rules or translation settings as needed.
5. Once satisfied, run the full workflow from Stage 1.

> **Note:** Pages captured in test mode count towards the project's page database just like a normal crawl. You can inspect them from **Stage 1 → View captured pages** at any time.

---

## Project Configuration

Each project has a `config.json` with the following structure:

```jsonc
{
  "name": "My Project",
  "slug": "my-project",
  "url": "https://example.com",

  // URLs where each translation will be deployed (used for hreflang tags)
  "targetUrls": {
    "es": "https://es.example.com",
    "fr": "https://fr.example.com"
  },

  "siteType": "generic",   // "generic" | "nextjs"

  "crawl": {
    "delayMs": 1500,         // milliseconds between requests
    "delayJitterMs": 500,    // random extra delay to avoid detection
    "maxPages": 500,
    "ignorePatterns": ["/api/", "/admin/"],
    "normalizeTrailingSlash": true,
    "stripQueryParams": true
  },

  "paths": {
    "original": "/data/my-project/original",  // processed + pre-personalized HTML
    "raw": "/data/my-project/raw",            // raw Playwright HTML (for reprocessing)
    "translations": {
      "es": "/data/my-project/es",
      "fr": "/data/my-project/fr"
    }
  },

  "translation": {
    "provider": "ollama",
    "ollamaUrl": "http://localhost:11434",
    "model": ["gemma4", "gemma3:8b"],  // array = multi-model fallback (or a single string)
    "sourceLanguage": "en",
    "targetLanguages": ["es", "fr"],
    "batchSize": 20,           // fragments per Ollama API call
    "maxFragmentTokens": 2000, // max tokens per HTML fragment before splitting
    "maxRetries": 5,           // retries per model before moving to the next one (default: 5)
    "cacheExpiry": -1,         // -1 = no expiry | 0 = cache disabled | N = TTL in seconds
    "context": "Official docs for Bootstrap, a CSS/JS framework",  // injected into prompt
    "preserveTerms": ["Parcel", "Webpack", "Vite", "Sass"],        // terms never translated
    "translateCodeBlockComments": true  // translate comment spans inside <pre><code> blocks (default: true)
  },

  "personalization": {
    // Applied at end of Stage 1, BEFORE translation
    "preTranslation": [
      {
        "type": "remove_element",
        "selector": "script[src*='google-analytics']",
        "description": "Remove Google Analytics"
      }
    ],
    // Applied in Stage 3, AFTER translation
    "postTranslation": [
      {
        "type": "inject_html",
        "position": "body_end",
        "html": "<div id='my-banner'>Ad content</div>",
        "description": "Inject ad banner"
      },
      {
        "type": "replace_text",
        "search": "© 2024 Original Company",
        "replace": "© 2024 My Company",
        "description": "Replace copyright (all directories)"
      },
      {
        "type": "replace_text",
        "selector": "title",
        "search": "Acme",
        "replace": "Acme en Español",
        "languages": ["es"],
        "description": "Rename page titles in the Spanish output only"
      }
    ]
  },

  "copyAssetsMode": "copy"  // "copy" | "symlink"
}
```

### Personalization rule types

| Type | Required fields | Optional fields | Description |
|---|---|---|---|
| `remove_element` | `selector` | — | Removes all matching elements |
| `remove_attribute` | `selector`, `attribute` | — | Removes an attribute from matching elements |
| `replace_text` | `search`, `replace` | `selector` | Replaces all occurrences of a text string. Without `selector`: replaces in the entire body. With `selector`: scoped to matching elements only (e.g. `"title"` targets the `<title>` tag in `<head>`). |
| `inject_html` | `html`, `position` | — | Injects HTML at `head_end`, `body_start`, `body_end`, or `after_selector:<css>` |
| `add_attribute` | `selector`, `attribute`, `replace` | — | Sets an attribute value on matching elements |

All `postTranslation` rules also accept an optional `languages` array (e.g. `["es", "fr"]`) to restrict execution to specific language output directories. Omitting it applies the rule to all directories including `original/`.

---

## Output Directory Structure

```
/data/my-project/
├── raw/                        ← Raw Playwright HTML (pre-adapter)
│   ├── index.html
│   └── about/index.html
│
├── original/                   ← Processed + pre-personalized HTML
│   ├── _redirects              ← Cloudflare Pages / Netlify redirect rules
│   ├── index.html
│   ├── about/index.html
│   └── _assets/                ← All downloaded assets (CSS, JS, images, fonts)
│
├── es/                         ← Spanish — fully independent, deploy to es.example.com
│   ├── _redirects              ← Same redirect rules (paths are root-relative)
│   ├── index.html
│   ├── translations.js         ← Runtime patch (Next.js sites only)
│   ├── about/
│   │   ├── index.html
│   │   └── translations.js
│   └── _assets/
│
└── fr/                         ← French — fully independent, deploy to fr.example.com
    ├── _redirects
    ├── index.html
    └── ...
```

Each language directory is **fully self-contained** and can be deployed independently.

---

## Redirect Detection

During the crawl (Stage 1), staticl10n intercepts HTTP 3xx responses via Playwright's response events and records every redirect it encounters — including trailing-slash normalizations, URL aliases, and permanent moves.

### How it works

1. **Detection** — for every URL visited, a `response` listener captures the first 3xx status code. If the final URL after navigation differs from the requested one, a redirect entry is recorded.
2. **Storage** — redirects are persisted to `projects/<slug>/redirects.json` in a hosting-agnostic format. The file is merged on each crawl run, so re-crawls update existing entries.
3. **Generation** — at the end of `Capture pending pages`, a `_redirects` file in Cloudflare Pages / Netlify format is written to `original/`. Stage 2 copies it to every language directory automatically.

### `redirects.json` schema

```jsonc
{
  "detectedAt": "2025-06-11T12:00:00Z",
  "totalRedirects": 3,

  // Populated automatically by the crawler
  "redirects": [
    { "from": "/about-us", "to": "/about", "statusCode": 301, "detectedDuring": "crawl" },
    { "from": "/services/", "to": "/services", "statusCode": 308, "detectedDuring": "crawl" }
  ],

  // Add entries here manually for redirects not linked from any crawled page
  "manual": [
    { "from": "/promo", "to": "/offers", "statusCode": 302, "description": "Campaign redirect" }
  ]
}
```

### Generated `_redirects` format

```text
# Generated automatically by staticl10n
# Detected redirects: 2 | Manual: 1

/about-us  /about  301
/services/  /services  308
/promo  /offers  302
```

### CLI options

Under **Stage 1: Capture** in the interactive menu:

| Option | Description |
|---|---|
| **View detected redirects** | Lists all entries from `redirects.json` with status codes |
| **Regenerate _redirects file** | Re-generates `_redirects` in `original/` and all language directories from the current `redirects.json` |

The **Regenerate** option is useful after manually adding entries to the `manual` array in `redirects.json`.

---

## Cron / Non-Interactive Mode

Run change detection without user interaction (for scheduling with `cron`):

```bash
staticl10n check my-project
```

Example cron entry to check daily at 6 AM:

```cron
0 6 * * * /usr/local/bin/staticl10n check my-project >> /var/log/staticl10n.log 2>&1
```

Results are saved to the database and printed to stdout. Pending changes can then be reviewed and re-processed from the interactive menu (Stage 4).

---

## How Translation Works

1. **Fragment extraction** — `cheerio` walks the DOM top-down. Block elements with a text/markup ratio > 60% are extracted as complete HTML fragments. Children of already-extracted elements are skipped to avoid double-translation.

2. **Cache lookup** — each fragment is SHA-256 hashed. Entries are matched by hash, target language, **and the configured model name** — switching to a different model automatically bypasses stale cache entries. The optional `cacheExpiry` setting (in seconds) limits how long entries are reused; set it to `0` to disable the cache entirely (default: `-1`, no expiry).

3. **Ollama API call** — uncached fragments are sent to Ollama in batches. The model is instructed to translate visible text while preserving all HTML tags, attributes, class names, IDs and URLs.

4. **Integrity verification & multi-model fallback** — the translated HTML is parsed and tag counts + significant attributes are compared with the original. Failures trigger automatic retries up to `maxRetries` (default 5) for the current model. If all retries for that model fail, the next model in the `model` array is tried with a fresh `maxRetries` budget. Once all models are exhausted, a text-node fallback strategy translates only the visible text nodes while leaving the HTML structure untouched. Setting `model` to a plain string is equivalent to a single-element array. All translations are cached under the primary (first) model name, so switching models in the array does not invalidate existing cache entries.

5. **Code comment translation** — after the main fragment pass, each `<pre><code>` block is scanned for Prism `token comment` spans. Contiguous groups (e.g. consecutive `//` comment lines) are joined, sent to the model as plain text, and the translated lines are redistributed back into the original spans. Code, identifiers, strings, and all HTML structure are never touched. Set `translateCodeBlockComments: false` to disable this step.

6. **Sitemap generation** — after all pages are translated, a `sitemap.xml` is written to the root of each language's output directory. URLs are computed by appending each page's path to the `targetUrls[lang]` configured for that language (falls back to `url` if not set). Only successfully translated pages are included.

7. **Dual injection** — translated HTML is written directly into the output file (for SEO / first paint) AND stored in a per-page `translations.js` dictionary (for Next.js rehydration defense).

8. **Meta & SEO** — `<title>`, `<meta name="description">`, Open Graph, Twitter Card, JSON-LD structured data, `<html lang>`, and `hreflang` alternate links are all processed.

---

## Next.js Sites

The Next.js adapter handles several complexities automatically:

- **React rehydration** — waits for full hydration before capturing the DOM, then generates a `translations.js` runtime patch that defends translated text against React re-renders using a `MutationObserver`.
- **Anti-flicker** — injects `<style id="staticl10n-hide">body{opacity:0}</style>` in `<head>` and reveals the page via `requestIdleCallback` after the patch has been applied.
- **Image optimization URLs** — `/_next/image?url=...` are unwrapped to their original paths.
- **SPA navigation prevention** — a click listener forces full-page reloads so Next.js doesn't attempt to load missing JSON chunks.
- **Prefetch cleanup** — `<link rel="preload/prefetch/modulepreload">` tags pointing to `/_next/` are removed (they 404 on static hosting).
- **CSS & fonts** — CSS modules, global CSS files, and `next/font` woff2 files under `/_next/static/media/` are all downloaded and path-rewritten.

---

## Data Storage

All state is stored in `data/staticl10n.db` (SQLite). Tables:

| Table | Purpose |
|---|---|
| `projects` | Registered projects |
| `pages` | Discovered URLs with crawl/capture status |
| `page_translations` | Translation status per page per language |
| `translation_cache` | Translation memory (source hash → translated text) |
| `stage_runs` | Execution log for each stage run |
| `change_detections` | Change monitoring results |

Logs are written to `data/logs/staticl10n-<timestamp>.log`.

---

## Development

```bash
# Run in development mode (tsx, no build needed)
pnpm dev

# Build TypeScript to dist/
pnpm build

# Run the built binary
pnpm start
```

Enable debug logging:

```bash
DEBUG=1 pnpm dev
```

---

## License

MIT © 2024 staticl10n contributors
