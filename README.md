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
- **Untranslated link rewriting** — links to pages not yet translated are automatically rewritten to absolute URLs pointing to the original site, so visitors are never sent to a missing translated page.
- **Path rewriting** — optional regex rules strip or transform URL path prefixes at output time (files, links, sitemap, hreflang), e.g. `/en/getting-started/` → `/getting-started/`.
- **Cross-project domain mapping** — `domainMap` rewrites links to sibling sites (e.g. `https://docs.astro.build` → `https://astro-docs.esdocu.com`) so translated pages link to translated siblings instead of the originals.
- **Resume-safe** — every operation is saved atomically to SQLite; interrupted runs can be resumed without re-downloading.

---

## System Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| **Node.js** | 20 LTS or later | Uses native `fetch`, ESM modules |
| **pnpm** | 8 or later | `npm install -g pnpm` |
| **Playwright browsers** | Chromium | Installed automatically via `pnpm exec playwright install chromium` |
| **Ollama** | Latest | [https://ollama.com/download](https://ollama.com/download) |
| **A translation model** | e.g. `gemma4`, `gemma3` | `ollama pull gemma4` |
| **sqlite3 CLI** | Any | Optional, required for native database backup feature (`brew install sqlite` on macOS, `sudo apt install sqlite3` on Linux) |
| **zip CLI** | Any | Optional, required for database backup compression feature (`brew install zip` on macOS, `sudo apt install zip` on Linux) |

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

```text
  ╔═══════════════════════════════════════╗
  ║          staticl10n  v0.1.0           ║
  ║     Static Localization CLI Tool      ║
  ╚═══════════════════════════════════════╝

? Main Menu
  ❯ Manage projects
    Select active project  [no project selected]
    Backup database
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

The project config is saved to `projects/<slug>/config.yaml`. Edit it directly or use **Edit project config** to open it in `$EDITOR`.

### 3. Run the workflow

Select the project as active, then execute each stage in order:

```text
Stage 1: Capture
  → Detect URLs: Stage 1 (Discover & Save) # crawls and saves paths to temporary file
  → Detect URLs: Stage 2 (Import paths)    # imports verified paths from the file
  → Capture pending pages                  # downloads HTML + assets, writes _redirects
Stage 2: Translation
  → Translate all captured pages  # _redirects is copied to each language dir

Stage 3: Post-Personalization
  → Apply post-personalization rules  # injects your banners, replaces copyright, etc.
  → Re-apply post-processing          # reapplies link rewriting, hreflang updates, rules

Stage 4: Monitoring  (ongoing)
  → Check site for changes
```

---

## Single-Page Test Mode

Before processing an entire site, use the **⚡ Test: process single page** option to verify that the full pipeline works correctly on a single URL. This is especially useful for large sites where a full crawl could take a very long time.

### How to access it

From the main interactive menu, with a project already selected:

```text
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
| --- | --- |
| **Stage 1: Capture** | Opens the page with Playwright, applies the site adapter, downloads assets, saves to `original/` |
| **Stage 2: Translation** | Applies `preTranslation` rules in-memory, extracts translatable fragments, queries the LLM, injects translations into each language directory |
| **Stage 3: Post-personalization** | Applies `postTranslation` rules to the translated output (inject banners, replace text, etc.) |

### Example output

```text
  ⚡ Single-Page Test Mode
  Runs the full pipeline on a single URL so you can verify the output
  without processing the whole site.

? URL to test: https://example.com/about
? Languages to translate into: es, fr
? Which stages to run: Stage 1, Stage 2, Stage 3

  ✔ [1/3] Captured → /data/my-project/original/about/index.html
  ✔ [2/3] Translation done — cache hits: 0, misses: 42
         [es] → /data/my-project/es/about/index.html
         [fr] → /data/my-project/fr/about/index.html
  ✔ [3/3] Post-personalization done — 3 file(s) in: original, es, fr

  Test Summary
  ─────────────────────────────────────────
  Stage 1: Capture                   ✓ ok
  Stage 2: Translation               ✓ ok
  Stage 3: Post-personalization      ✓ ok

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
4. Adjust `config.yaml` rules or translation settings as needed.
5. Once satisfied, run the full workflow from Stage 1.

> **Note:** Pages captured in test mode count towards the project's page database just like a normal crawl. You can inspect them from **Stage 1 → View captured pages** at any time.

---

## Two-Stage Crawler Workflow

To prevent unwanted pages from being imported and captured, the URL detection process in **Stage 1: Capture** is split into two steps:

1. **Stage 1 (Discover & Save)**
   - The crawler crawls the website and discovers internal URLs matching `ignorePatterns` and `allowPatterns`.
   - Instead of inserting them into the database, it writes the list of unique paths to a temporary markdown file at `data/tmp/detected-paths-<projectSlug>.md` (one path per line), and a companion JSON metadata file at `data/tmp/crawler-metadata-<projectSlug>.json`.
   - Both files are ignored by git.

2. **Stage 2 (Import paths)**
   - You can open `data/tmp/detected-paths-<projectSlug>.md` in your editor, review the discovered paths, and delete the lines/paths you do not want to crawl or translate.
   - Run **Detect URLs: Stage 2 (Import paths)** in the CLI.
   - The CLI reads the reviewed markdown file, filters the corresponding page metadata and redirects, imports them into the local SQLite database, and automatically deletes the temporary markdown and JSON files.

---

## Project Configuration

Each project has a `config.yaml` file at `projects/<slug>/config.yaml`. The full reference — including all options, crawl filter modes, path rewriting, cross-project domain mapping, and personalization rules — is documented in:

**[→ projects/CONFIG-DOCS.md](projects/CONFIG-DOCS.md)**

---

## Output Directory Structure

```text
/data/my-project/
├── raw/                        ← Raw Playwright HTML (pre-adapter)
│   ├── index.html
│   └── about/index.html
│
├── original/                   ← Processed HTML (immutable — never modified after capture)
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

Redirects are handled across three distinct stages:

1. **Detection & Storage (Stage 1: Discover & Save)**
   - During the crawl discovery phase, staticl10n intercepts standard HTTP `3xx` redirects (via Playwright's `response` event listener) as well as client-side meta-refresh redirects (e.g. `<meta http-equiv="refresh" content="0;url=/target/">` parsed via cheerio from the response body).
   - If a redirect is detected, the target URL is enqueued to continue crawling from it, and the redirect mapping is registered.
   - Redirects are persisted to `projects/<slug>/redirects.json` in a hosting-agnostic format. The file is merged on each crawl run, so subsequent runs update existing entries without losing manually added ones.

2. **Generation (Stage 1: Capture)**
   - At the end of the `Capture pending pages` step, staticl10n reads `redirects.json` and writes a unified `_redirects` file (compatible with Netlify and Cloudflare Pages) to the `original/` directory.

3. **Replication (Stage 2: Translation)**
   - When translating the site, the `_redirects` file is automatically copied from the `original/` directory to all language output directories (`es/`, `fr/`, etc.), ensuring the redirects also function on the translated domains/paths.

### `redirects.json` schema

```jsonc
{
  "detectedAt": "2025-06-11T12:00:00Z",
  "totalRedirects": 3,

  // Populated automatically by the crawler
  "redirects": [
    { "from": "/about-us", "to": "/about", "statusCode": 301, "detectedDuring": "crawl", "disabled": false },
    { "from": "/services/", "to": "/services", "statusCode": 308, "detectedDuring": "crawl", "disabled": false }
  ],

  // Add entries here manually for redirects not linked from any crawled page
  "manual": [
    { "from": "/promo", "to": "/offers", "statusCode": 302, "description": "Campaign redirect", "disabled": false }
  ]
}
```

### Conflict Resolution & Disabling Redirects

- **Automatic Conflict Detection**: When generating target-language outputs, staticl10n compares source and target paths against `pathRewrite` rules. If a redirect conflicts with these rules (e.g., redirecting from `/` to `/en` when `/en/` is rewritten to `/`, which would cause an infinite loop or point to non-existent paths on the translated site), it is automatically skipped during `_redirects` generation.
- **Manual Disabling**: All redirect objects support a `"disabled"` boolean field (defaults to `false` when created/merging). You can manually change this to `true` in `redirects.json` to exclude the redirect from the generated `_redirects` file. The crawler preserves this setting on subsequent crawls so that the redirect is not re-enabled or re-crawled.

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
| --- | --- |
| **View detected redirects** | Lists all entries from `redirects.json` with status codes and disabled status |
| **Regenerate _redirects file** | Re-generates `_redirects` in `original/` and all language directories from the current `redirects.json` |

The **Regenerate** option is useful after manually adding entries to the `manual` array in `redirects.json` or disabling existing ones.

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

1. **Fragment extraction with placeholders** — `cheerio` walks the DOM top-down. Block elements with a text/markup ratio > 60% are extracted. Instead of sending raw HTML to the LLM, inline elements (`<a>`, `<span>`, `<strong>`, etc.) are replaced with numbered placeholder tags (e.g. `<1>`, `</1>`, `<2/>`). The original HTML tags and attributes are stored in a map for later reconstruction. This reduces token consumption (heavy attributes like long URLs are stripped) and ensures the LLM receives complete sentences with context, not isolated text nodes.

2. **Cache lookup & Model Priority** — each fragment is SHA-256 hashed. The database is checked for an existing cached translation for the target language. If one is found:
   - The tool compares the priority of the **current model** against the **cached model** using the global priority list defined in `data/global-config.yaml` (where more powerful models are placed at the top of the list for highest priority).
   - If the current model is **superior** (higher priority / more powerful) to the cached model, the cache is bypassed (forcing a re-translation) to upgrade the translation quality.
   - If the current model has **lower or equal priority**, the cached translation is reused, saving tokens and processing time.
   - The optional `cacheExpiry` setting (in seconds) limits how long entries are reused; set it to `0` to disable the cache entirely (default: `-1`, no expiry).

3. **LLM API call** — uncached fragments are sent to the configured provider (Ollama or Google Gemini) in batches. The prompt instructs the model to translate the text while preserving all placeholder tags exactly as they appear. The model places each placeholder around the equivalent translated words to maintain correct grammar (e.g. `Start your <1>journey</1> today` → `Comienza tu <1>viaje</1> hoy`).

4. **Integrity verification & multi-model fallback** — the translated text is checked to ensure all placeholder tags from the original are present (paired `<N>`/`</N>` or void `<N/>`). Failures trigger automatic retries up to `maxRetries` (default 5) for the current model. If all retries for that model fail, the next model in the `model` array is tried with a fresh `maxRetries` budget. Setting `model` to a plain string is equivalent to a single-element array. All successful translations are cached under the name of the model that successfully completed the translation, allowing relative priority comparisons in future runs.

5. **HTML reconstruction** — after translation, placeholders are replaced with the original HTML tags (e.g. `<1>` → `<span class="bold">`, `</1>` → `</span>`). The reconstructed HTML is injected back into the document.

6. **Code comment translation** — after the main fragment pass, each `<pre><code>` block is scanned for Prism `token comment` spans. Contiguous groups (e.g. consecutive `//` comment lines) are joined, sent to the model as plain text, and the translated lines are redistributed back into the original spans. Code, identifiers, strings, and all HTML structure are never touched. Set `translateCodeBlockComments: false` to disable this step.

7. **Link rewriting** — every `<a href>` is inspected and classified:
   - **Translated page** — relative links are left unchanged; absolute links that pointed to the source site (e.g. `http://localhost/…`) are rewritten to the target language domain.
   - **Not-yet-translated page** — the link is rewritten to an absolute URL on the original site (`config.url`), so visitors are never directed to a missing translated page. When running *Test: process single page*, all pages that were already translated in previous runs are treated as available and keep their relative links; only truly untranslated pages are redirected to the original.

8. **Sitemap generation** — after all pages are translated, a `sitemap.xml` is written to the root of each language's output directory. URLs are computed by appending each page's path to the `targetUrls[lang]` configured for that language (falls back to `url` if not set). The sitemap always reflects the **complete set of translated pages** stored in the database — not just those processed in the current run — so partial runs (e.g. single-page tests) still produce a full sitemap.

9. **Dual injection** — translated HTML is written directly into the output file (for SEO / first paint) AND stored in a per-page `translations.js` dictionary (for Next.js rehydration defense).

    10. **Meta & SEO** — `<title>`, `<meta name="description">`, Open Graph, Twitter Card, JSON-LD structured data, `<html lang>`, and `hreflang` alternate links are all processed.

---

## Manual Translation Mode

If you prefer to translate pages manually instead of using automated LLM providers, you can use the **(manual)** options in **Stage 2: Translation**. This workflow operates in three distinct stages:

### 1. Generate Manual Files (Stage 1)
- Generates HTML and YAML part files under `{paths.tmp}/translation/{language}/` with filenames like `{page_id}-part{x}.html` and `{page_id}-part{x}.yaml`.
- Each part file is limited to ~100 lines for easy editing.
  - Plain, inline, single-line fragments are written to `.yaml` files in key-value format.
  - Multiline fragments or fragments containing HTML placeholders (e.g. `<span id="N">`) are written to `.html` files wrapped in `<div id="{id}">` tags.
- Identical original source files are written to `{paths.tmp}/translation/{language}-original/` to prevent mixing or losing original source text references.
- Pre-fills the translation files under `{language}/` with existing cached translations (if available) or the original source text.

### 2. Import & Validate (Stage 2)
- Reads the edited translation files from `{paths.tmp}/translation/{language}/`.
- Validates the translations against the original files in `{language}-original/` to ensure all HTML placeholder tags are preserved.
- If validation succeeds, the translations are saved to the database cache under the model name `'manual'` and the files are deleted.
- If any fragments fail validation, the CLI reports the placeholder/structural errors and regenerates new part files containing **only** the failed fragments for you to correct.

### 3. Build Pages (Stage 3)
- Verifies that no manual translation part files are left in `{paths.tmp}/translation/{language}/`.
- Compiles the final localized website pages exactly like automated translation, but retrieves translations exclusively from the database cache (falling back to original text for any uncached fragments).

### Cache Priority
By adding `manual` to the top of `model_priorities` in `data/global-config.yaml`, manually imported translations take the highest priority and will never be overwritten or updated by other models during automated translation runs.

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

All state is stored in `data/db/staticl10n.db` (SQLite). Tables:

| Table | Purpose |
| --- | --- |
| `projects` | Registered projects |
| `pages` | Discovered URLs with crawl/capture status |
| `page_translations` | Translation status per page per language |
| `translation_cache` | Translation memory (source hash → translated text) |
| `stage_runs` | Execution log for each stage run |
| `change_detections` | Change monitoring results |

Logs are written to `data/logs/staticl10n-<timestamp>.log`.

### Database Backups

The CLI tool features a tiered, automated database backup system. If `DB_BACKUP_DIR` is configured in your `.env` file, the tool will store compressed backups under the following directories:
- `hourly/` — Backs up the database once per hour.
- `daily/` — Copies the current hour's backup once per day.
- `weekly/` — Copies the current hour's backup once per week.
- `monthly/` — Copies the current hour's backup once per month.

#### Retention Policies
You can configure how many backups to keep for each tier under the `backup_retention` section of `data/global-config.yaml`:
```yaml
backup_retention:
  hourly: 24
  daily: 7
  weekly: 4
  monthly: 12
```

#### Triggering Backups
Backups are triggered in three ways:
1. **Manually**: By selecting the **Backup database** option (Option 3) in the main interactive menu.
2. **On Graceful Exit**: Automatically when selecting **Exit** from the main menu.
3. **On Interruption**: Automatically if you exit the CLI using `Ctrl+C` (SIGINT).

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
