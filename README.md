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
| **A translation model** | e.g. `llama3.1`, `gemma3` | `ollama pull llama3.1` |

### Install Ollama

```bash
# macOS
brew install ollama
ollama serve          # starts the Ollama server on http://localhost:11434

# Pull a recommended translation model
ollama pull llama3.1
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
  → Detect URLs (crawler)       # discovers all pages
  → Capture pending pages       # downloads HTML + assets
  → Apply pre-personalization   # removes analytics, cookie banners, etc.

Stage 2: Translation
  → Translate all captured pages

Stage 3: Post-Personalization
  → Apply post-personalization rules  # injects your banners, replaces copyright, etc.

Stage 4: Monitoring  (ongoing)
  → Check site for changes
```

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
    "model": "llama3.1",
    "sourceLanguage": "en",
    "targetLanguages": ["es", "fr"],
    "batchSize": 20,          // fragments per API call
    "maxFragmentTokens": 2000 // max tokens per HTML fragment
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
    // Applied in Stage 3, AFTER translation, to ALL language directories
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
        "description": "Replace copyright"
      }
    ]
  },

  "copyAssetsMode": "copy"  // "copy" | "symlink"
}
```

### Personalization rule types

| Type | Required fields | Description |
|---|---|---|
| `remove_element` | `selector` | Removes all matching elements |
| `remove_attribute` | `selector`, `attribute` | Removes an attribute from matching elements |
| `replace_text` | `search`, `replace` | Replaces all occurrences of a text string in the body |
| `inject_html` | `html`, `position` | Injects HTML at `head_end`, `body_start`, `body_end`, or `after_selector:<css>` |
| `add_attribute` | `selector`, `attribute`, `replace` | Sets an attribute value on matching elements |

---

## Output Directory Structure

```
/data/my-project/
├── raw/                        ← Raw Playwright HTML (pre-adapter)
│   ├── index.html
│   └── about/index.html
│
├── original/                   ← Processed + pre-personalized HTML
│   ├── index.html
│   ├── about/index.html
│   └── _assets/                ← All downloaded assets (CSS, JS, images, fonts)
│
├── es/                         ← Spanish — fully independent, deploy to es.example.com
│   ├── index.html
│   ├── translations.js         ← Runtime patch (Next.js sites only)
│   ├── about/
│   │   ├── index.html
│   │   └── translations.js
│   └── _assets/
│
└── fr/                         ← French — fully independent, deploy to fr.example.com
    ├── index.html
    └── ...
```

Each language directory is **fully self-contained** and can be deployed independently.

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

2. **Cache lookup** — each fragment is SHA-256 hashed. Previously translated fragments are served from the local SQLite cache with no API calls.

3. **Ollama API call** — uncached fragments are sent to Ollama in batches. The model is instructed to translate visible text while preserving all HTML tags, attributes, class names, IDs and URLs.

4. **Integrity verification** — the translated HTML is parsed and tag counts + significant attributes are compared with the original. Failures trigger up to 3 retries.

5. **Dual injection** — translated HTML is written directly into the output file (for SEO / first paint) AND stored in a per-page `translations.js` dictionary (for Next.js rehydration defense).

6. **Meta & SEO** — `<title>`, `<meta name="description">`, Open Graph, Twitter Card, JSON-LD structured data, `<html lang>`, and `hreflang` alternate links are all processed.

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
