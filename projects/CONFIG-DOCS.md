# Project Configuration Reference

Each project has a `config.yaml` file inside its folder under `projects/<slug>/config.yaml`. This document is the full reference for every available option.

## Full example

```yaml
# Display name of the project (shown in the interactive UI)
name: My Project

# Unique identifier — also used as the folder name under projects/
slug: my-project

# URL of the source site to crawl and translate
url: https://example.com

# Deployed URLs for each translated language (used to generate hreflang tags and rewrite links)
targetUrls:
  es: https://es.example.com
  fr: https://fr.example.com

# Site type: "generic" (Hugo, Astro, VitePress, Jekyll…) or "nextjs" (Next.js app with React hydration)
siteType: generic

crawl:
  # Milliseconds to wait between page requests (reduces server load)
  delayMs: 1500
  # Additional random delay per request (helps avoid bot detection)
  delayJitterMs: 500
  # Maximum number of pages to crawl (set to a high value to crawl everything)
  maxPages: 5000
  # Blocklist mode: skip URLs whose pathname contains any of these strings
  ignorePatterns: ["/api/", "/admin/"]
  # Allowlist mode: ONLY crawl paths that contain at least one of these strings
  # Mutually exclusive with ignorePatterns — use one or the other, not both.
  # allowPatterns: ["/en/"]
  # Strip trailing slashes from crawled URLs for consistent deduplication
  normalizeTrailingSlash: true
  # Remove query parameters from crawled URLs (keeps ?lang=, ?v=... out of the page list)
  stripQueryParams: true
  # Extra delay (ms) after page hydration — increase for JS-heavy sites like Next.js
  postHydrationDelayMs: 800

paths:
  # Where processed + pre-personalized HTML files are saved (Stage 1 output)
  original: /data/my-project/original
  # Where raw Playwright HTML is saved (used for reprocessing without re-crawling)
  raw: /data/my-project/raw
  # Output directories per target language
  translations:
    es: /data/my-project/es
    fr: /data/my-project/fr

translation:
  # Translation provider: "ollama" (local, no API key) or "gemini" (Google Gemini API)
  provider: ollama
  # Base URL of the local Ollama server (only used when provider is "ollama")
  ollamaUrl: "http://localhost:11434"
  # Model name or list of models for multi-model fallback (tried in order on failure)
  # Comment out any model to temporarily disable it
  model:
    - gemma4
    - gemma3:8b
  # Language code of the source content (ISO 639-1, e.g. "en", "es", "fr")
  sourceLanguage: en
  # Target languages to translate into (must match keys in targetUrls and paths.translations)
  targetLanguages: ["es", "fr"]
  # Number of HTML fragments sent to the model in a single API call
  batchSize: 20
  # Maximum token count per HTML fragment before it is split into smaller pieces
  maxFragmentTokens: 2000
  # Retries per model before moving to the next one in the list (default: 5)
  maxRetries: 5
  # Cache entry lifetime in seconds. -1 = no expiry | 0 = cache disabled | N = TTL in seconds
  cacheExpiry: -1
  # Optional context injected into the translation prompt (describe the site for better accuracy)
  context: "Official docs for Bootstrap, a CSS/JS framework"
  # Terms that must never be translated (brand names, technical terms, trademarks, etc.)
  preserveTerms: ["Parcel", "Webpack", "Vite", "Sass"]
  # Set to true to translate comment spans inside <pre><code> blocks (default: true)
  translateCodeBlockComments: true

personalization:
  # Rules applied in-memory at the START of Stage 2, before fragment extraction.
  # original/ is NEVER modified — it remains immutable after capture.
  # This means you can change these rules and re-run Stage 2 without re-capturing.
  # Use to remove analytics, tracking scripts, cookie banners, ads, etc.
  preTranslation:
    - type: remove_element
      selector: "script[src*='google-analytics']"
      description: Remove Google Analytics
  # Rules applied AFTER translation (applied automatically during translation/build for both AI and manual modes)
  # Use to inject banners, replace copyright text, rename page titles, etc.
  # Add "languages: [es, fr]" to a rule to restrict it to specific language outputs.
  postTranslation:
    - type: inject_html
      position: body_end
      html: "<div id='my-banner'>Ad content</div>"
      description: Inject ad banner
    - type: replace_text
      search: "© 2024 Original Company"
      replace: "© 2024 My Company"
      description: Replace copyright (all directories)
    - type: replace_text
      selector: title
      search: Acme
      replace: Acme en Español
      languages: ["es"]
      description: Rename page titles in the Spanish output only

# How to handle static assets (CSS, JS, images, fonts): "copy" (default) or "symlink"
copyAssetsMode: copy

# Optional: regex rules to rewrite URL pathnames at output time (output files, links, sitemap, hreflang).
# Useful when crawling a language-prefixed site (e.g. /en/…) but publishing without the prefix.
pathRewrite:
  - pattern: "^/en/"
    replacement: "/"

# Optional: map sibling-project domains to their translated equivalents (per language).
# Links in translated HTML pointing to a mapped domain are rewritten to the target language URL.
domainMap:
  "https://docs.astro.build":
    es: https://astro-docs.esdocu.com
```

---

## Translation providers

The `translation.provider` field selects which LLM backend is used. Two providers are supported:

### `ollama` (default — local, no API key required)

Runs translations through a locally-installed [Ollama](https://ollama.com) instance. No internet connection or API key is needed.

```yaml
translation:
  provider: ollama
  ollamaUrl: "http://localhost:11434"
  # Comment out any model to temporarily disable it
  model:
    - llama3.1
    - gemma4
  sourceLanguage: en
  targetLanguages: ["es"]
```

- `ollamaUrl` — base URL of the Ollama server. Required when using this provider.
- `model` — a single model name or an array for multi-model fallback (tried in order when a request fails or the integrity check does not pass).

### `gemini` — Google Gemini API

Uses the [Google Gemini](https://ai.google.dev) REST API. Requires an API key stored in the `.env` file (see [Environment variables](#environment-variables)).

```yaml
translation:
  provider: gemini
  # Comment out any model to temporarily disable it
  model:
    - gemini-2.5-flash-lite
    - gemini-3.1-flash-lite
  sourceLanguage: en
  targetLanguages: ["es"]
```

- `ollamaUrl` — not used; omit it.
- `model` — a Gemini model name (e.g. `"gemini-2.0-flash"`, `"gemini-1.5-pro"`) or an array for multi-model fallback.

> Multi-model fallback works the same way for both providers: models in the array are tried in order. If all models fail for a fragment, the original text is kept and a warning is logged.

---

## Environment variables

Sensitive credentials (API keys) are stored in a `.env` file at the project root. **Never commit this file** — it is listed in `.gitignore`.

Copy `.env.example` to `.env` and fill in the keys for the providers you use:

```sh
cp .env.example .env
```

### `.env.example` reference

```dotenv
# Google Gemini (used when translation.provider = "gemini")
# Get your key at: https://aistudio.google.com/app/apikey
GOOGLE_GEMINI_API_KEY=

# OpenAI (reserved for future use)
# OPENAI_API_KEY=

# Mistral AI (reserved for future use)
# MISTRAL_API_KEY=

# Anthropic Claude (reserved for future use)
# ANTHROPIC_API_KEY=
```

### Variable reference

| Variable | Provider | Description |
| --- | --- | --- |
| `GOOGLE_GEMINI_API_KEY` | `gemini` | Google Gemini REST API key. Required when `translation.provider` is `"gemini"`. |
| `OPENAI_API_KEY` | *(future)* | OpenAI API key — reserved for a future provider. |
| `MISTRAL_API_KEY` | *(future)* | Mistral AI API key — reserved for a future provider. |
| `ANTHROPIC_API_KEY` | *(future)* | Anthropic Claude API key — reserved for a future provider. |

The `.env` file is loaded automatically at startup using Node.js's built-in env-file loader (Node 20.12+). No external library is required.

---

## Crawl filter modes

The `crawl` object supports two mutually exclusive URL filter modes. Use **one or the other** — if both are set, `allowPatterns` takes precedence and a warning is logged.

Patterns starting with `^` or ending with `$` are compiled and evaluated as **regular expressions** (tested against the URL pathname). Other patterns are matched as simple substrings/substring prefixes using `.includes()`.

### `ignorePatterns` — blocklist (default)

Crawl all discovered URLs **except** those whose pathname matches at least one of the listed patterns.

```yaml
crawl:
  ignorePatterns: ["/blog/", "/api/", "^/fr$", "^/fr/"]
```

All paths are visited unless they match a blocked prefix/substring/regex.

### `allowPatterns` — allowlist

Crawl **only** URLs whose pathname matches at least one of the listed patterns. Everything else is silently skipped.

```yaml
crawl:
  allowPatterns: ["^/en/"]
```

Useful when the source site serves multiple language versions under different path prefixes (e.g. `/en/`, `/fr/`, `/de/`) and you only want to translate one of them. Combined with `pathRewrite`, you can strip the language prefix from the translated output:

```yaml
crawl:
  allowPatterns: ["/en/"]

pathRewrite:
  - pattern: "^/en/"
    replacement: "/"
```

This crawls only `/en/…` pages and publishes them at `/…` on the translated site.

---

## Path rewriting

`pathRewrite` is an optional array of rules applied in order to every URL **pathname** at output time. Each rule is a regex `pattern` + `replacement` pair (standard JavaScript `String.replace` semantics, so capture groups like `$1` work).

Rewrites are applied to:

- **Output file paths** — the translated HTML is written to the rewritten path instead of the original one (e.g. `es/getting-started/index.html` instead of `es/en/getting-started/index.html`).
- **Internal links** — `<a href>` links to translated pages use the rewritten path. Links to untranslated pages still use the original path on the original site.
- **Sitemap** — `<loc>` entries use the rewritten path.
- **hreflang alternate links** — target-language `<link rel="alternate">` tags use the rewritten path. The source-language and `x-default` links keep the original path (they point back to the original site).

**Typical use case — Astro / multi-language docs site:**

Sites like `https://docs.astro.build` serve their canonical English content under `/en/…`. If you only want to crawl and translate the English content but publish it at the root of your translated domain (e.g. `https://astro-es.example.com/getting-started/` instead of `.../en/getting-started/`), add:

```yaml
pathRewrite:
  - pattern: "^/en/"
    replacement: "/"
```

This leaves non-English source paths (if any are accidentally crawled) untouched since the pattern only matches paths that start with `/en/`.

---

## Cross-project domain mapping

`domainMap` is an optional object that maps external domains to their translated equivalents **per target language**. Each key is an external origin; each value is an object mapping language codes to the translated domain for that language. When the translated HTML contains `<a href>` links pointing to a mapped domain, the link's origin is replaced with the value for the current target language, preserving the original pathname, query string, and fragment. If there is no entry for the current language, the link is left unchanged.

This is designed for projects that span **multiple related sites** — for example, a main website and its documentation hosted on a separate subdomain.

**Example — Astro ecosystem:**

The Astro project has two separate sites:

| Original | Translated |
| --- | --- |
| `https://astro.build` | `https://astro.esdocu.com` |
| `https://docs.astro.build` | `https://astro-docs.esdocu.com` |

Each site is a separate staticl10n project. To make cross-site links point to the translated siblings:

**In the `astro.build` project config:**

```yaml
domainMap:
  "https://docs.astro.build":
    es:
      url: https://astro-docs.esdocu.com
      pathRewrite:
        - pattern: "^/en/"
          replacement: "/"
    fr: https://astro-docs.frdocu.com
```

**In the `docs.astro.build` project config:**

```yaml
domainMap:
  "https://astro.build":
    es: https://astro.esdocu.com
    fr: https://astro.frdocu.com
```

With this configuration, a link like `<a href="https://docs.astro.build/en/getting-started/">` in the Spanish translation of the main site will be correctly rewritten to `<a href="https://astro-docs.esdocu.com/getting-started/">` (applying the custom path rewrite to strip the `/en/` prefix), while the French translation will point to `https://astro-docs.frdocu.com/en/getting-started/`.

> **Note:** `domainMap` only rewrites cross-project links. Internal links (same origin as `config.url`) are handled by the existing translated/untranslated link rewriting logic. If the target project uses `pathRewrite`, you can define custom `pathRewrite` rules under the specific language code in `domainMap` (by providing an object with `url` and `pathRewrite` instead of a raw URL string) to make sure mapped links are rewritten correctly. If no custom rules are provided in `domainMap`, the path remains unchanged.

---

## Internal linking / affiliate conversion links

The `internalLinking` section implements the strategy described in `design/estrategia-de-enlazado-interno.md`. It has three parts:

1. **`brandFooterHtml`** — §1 *Domain Authority*: a structural, non-commercial HTML fragment injected right before `</body>` on **every** page of the site (all directories, all languages). Independent of `links`.
2. **`defaultLinkTemplate`** — default HTML template used by any link in `links` that doesn't define its own `htmlTemplate`.
3. **`links`** — §2–§5: a list of affiliate/conversion link placements, each injecting a styled HTML fragment (not just a bare `<a>` tag) into a specific page at a specific CSS selector.

Conversion articles are **not** hardcoded per project. They are defined once in the centralized registry `data/conversion-articles.yaml` and referenced by `articleId`:

```yaml
# data/conversion-articles.yaml
articles:
  - id: mejor-hosting
    url: "https://esdocu.com/mejor-hosting"
    title: "Mejor Hosting"
    topics: [hosting, servidores, deployment]
```

### HTML templates and placeholders

Both `defaultLinkTemplate` and per-link `htmlTemplate` support three placeholders, replaced at injection time:

| Placeholder | Replaced with |
| --- | --- |
| `{{url}}` | The conversion article's URL (from `data/conversion-articles.yaml`). |
| `{{anchorText}}` | The rule's `anchorText` value. |
| `{{title}}` | The conversion article's `title` (from `data/conversion-articles.yaml`). |

If a link doesn't set `htmlTemplate` and `defaultLinkTemplate` is also unset, the fallback is a plain `<a href="{{url}}" rel="sponsored noopener">{{anchorText}}</a>`.

### Project config.yaml example

```yaml
internalLinking:
  # §1 — Injected before </body> on EVERY page (all languages, including original/).
  brandFooterHtml: |
    <div class="text-center text-muted small py-3 border-top">
      Traducción mantenida por <a href="https://esdocu.com" rel="noopener">Esdocu</a>
    </div>

  # Default styled template for links below that don't set their own htmlTemplate.
  defaultLinkTemplate: |
    <div class="alert alert-light border my-4" role="note">
      💡 Si estás en este punto, quizás te interese <a href="{{url}}" rel="sponsored noopener">{{anchorText}}</a>.
    </div>

  links:
    - articleId: mejor-hosting       # must match an id in data/conversion-articles.yaml
      placement: home                # "home" (max 1/subdomain) or "internal" (3-5/subdomain)
      page: "/"                      # page pathname this rule targets
      selector: "main"               # CSS anchor point
      position: "body_end"           # optional: head_end | body_start | body_end | after_selector:<css> (default: after_selector:<selector>)
      anchorText: "proveedores de infraestructura recomendados"  # must be unique within the project
      languages: ["es"]              # optional: restrict to specific output languages
      description: "Home — Recursos Recomendados"

    # This rule overrides the default template with a custom card matching the site's design.
    - articleId: mejor-hosting
      placement: internal
      page: "/docs/5.3/getting-started/download/"
      selector: "h2#cdn-via-jsdelivr"
      anchorText: "revisa estas opciones de servidores para producción"
      htmlTemplate: |
        <div class="card border-primary my-4">
          <div class="card-body">
            <p class="card-text mb-0">🚀 Antes de desplegar, <a href="{{url}}" class="card-link" rel="sponsored noopener">{{anchorText}}</a>.</p>
          </div>
        </div>
      languages: ["es"]
      description: "Download page — hosting mention"
```

### Field reference

**`internalLinking` (top-level):**

| Field | Required | Description |
| --- | --- | --- |
| `brandFooterHtml` | no | HTML fragment injected before `</body>` on every page (§1 Domain Authority). |
| `defaultLinkTemplate` | no | Default HTML template for links without their own `htmlTemplate`. Supports `{{url}}`, `{{anchorText}}`, `{{title}}`. |
| `links` | no | Array of `ConversionLinkRule` entries (see below). |

**`ConversionLinkRule` (each entry in `links`):**

| Field | Required | Description |
| --- | --- | --- |
| `articleId` | yes | ID of the conversion article, resolved against `data/conversion-articles.yaml`. |
| `placement` | yes | `"home"` (max 1 per subdomain) or `"internal"` (3 to 5 per subdomain). |
| `page` | yes | Page pathname the rule applies to (e.g. `"/docs/5.3/getting-started/download/"`). |
| `selector` | yes | CSS selector used as the anchor point for injection. |
| `position` | no | Injection position. Defaults to `after_selector:<selector>`. |
| `anchorText` | yes | Organic anchor text. Must not repeat within the same project. |
| `htmlTemplate` | no | Per-rule HTML template overriding `defaultLinkTemplate`. Supports `{{url}}`, `{{anchorText}}`, `{{title}}`. |
| `languages` | no | Restrict to specific output language directories. Omit to apply to all, including `original/`. |
| `description` | no | Free-text note for maintainers. |

### Audit script

Run `pnpm audit:internal-linking` to scan every project's `internalLinking` section, validate all the quotas and rules from the strategy document, and update the centralized usage registry at `data/internal-linking-registry.yaml`. The script:

- Validates link quotas (home ≤ 1, internal 3–5, total 4–6 per subdomain).
- Checks anchor text uniqueness within each project.
- Resolves every `articleId` against `data/conversion-articles.yaml`.
- Warns about projects missing `brandFooterHtml` (§1 Domain Authority, non-blocking).
- Warns about footprint risks (same `articleId` + `anchorText` reused across projects).
- Exits with a non-zero status if any project violates the strategy.

---

## Personalization rule types

| Type | Required fields | Optional fields | Description |
| --- | --- | --- | --- |
| `remove_element` | `selector` | — | Removes all matching elements |
| `remove_attribute` | `selector`, `attribute` | — | Removes an attribute from matching elements |
| `replace_text` | `search`, `replace` | `selector` | Replaces all occurrences of a text string. Without `selector`: replaces in the entire body. With `selector`: scoped to matching elements only (e.g. `"title"` targets the `<title>` tag in `<head>`). |
| `inject_html` | `html`, `position` | — | Injects HTML at `head_end`, `body_start`, `body_end`, or `after_selector:<css>` |
| `add_attribute` | `selector`, `attribute`, `replace` | — | Sets an attribute value on matching elements |

All `postTranslation` rules also accept an optional `languages` array (e.g. `["es", "fr"]`) to restrict execution to specific language output directories. Omitting it applies the rule to all directories including `original/`.
