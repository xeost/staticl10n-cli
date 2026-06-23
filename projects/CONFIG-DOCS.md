# Project Configuration Reference

Each project has a `config.json` file inside its folder under `projects/<slug>/config.json`. This document is the full reference for every available option.

## Full example

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
    // Blocklist mode: skip paths that contain any of these strings (default)
    "ignorePatterns": ["/api/", "/admin/"],
    // Allowlist mode: ONLY crawl paths that contain at least one of these strings
    // Mutually exclusive with ignorePatterns — use one or the other, not both.
    // "allowPatterns": ["/en/"],
    "normalizeTrailingSlash": true,
    "stripQueryParams": true,
    "postHydrationDelayMs": 800  // ms to wait after hydration (Next.js sites)
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
    "provider": "ollama",              // "ollama" | "gemini"
    "ollamaUrl": "http://localhost:11434",  // only required for provider "ollama"
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

  "copyAssetsMode": "copy",  // "copy" | "symlink"

  // Optional: rewrite URL pathnames at output time (output files, links, sitemap, hreflang).
  // Useful when crawling a language-prefixed version of a site but publishing without the prefix.
  "pathRewrite": [
    { "pattern": "^/en/", "replacement": "/" }
  ],

  // Optional: map sibling-project domains to their translated equivalents (per language).
  // Links in translated HTML pointing to a key domain are rewritten to the value for the
  // current target language.
  "domainMap": {
    "https://docs.astro.build": {
      "es": "https://astro-docs.esdocu.com"
    }
  }
}
```

---

## Translation providers

The `translation.provider` field selects which LLM backend is used. Two providers are supported:

### `ollama` (default — local, no API key required)

Runs translations through a locally-installed [Ollama](https://ollama.com) instance. No internet connection or API key is needed.

```json
"translation": {
  "provider": "ollama",
  "ollamaUrl": "http://localhost:11434",
  "model": ["llama3.1", "gemma4"],
  "sourceLanguage": "en",
  "targetLanguages": ["es"]
}
```

- `ollamaUrl` — base URL of the Ollama server. Required when using this provider.
- `model` — a single model name or an array for multi-model fallback (tried in order when a request fails or the integrity check does not pass).

### `gemini` — Google Gemini API

Uses the [Google Gemini](https://ai.google.dev) REST API. Requires an API key stored in the `.env` file (see [Environment variables](#environment-variables)).

```json
"translation": {
  "provider": "gemini",
  "model": ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite"],
  "sourceLanguage": "en",
  "targetLanguages": ["es"]
}
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
|---|---|---|
| `GOOGLE_GEMINI_API_KEY` | `gemini` | Google Gemini REST API key. Required when `translation.provider` is `"gemini"`. |
| `OPENAI_API_KEY` | *(future)* | OpenAI API key — reserved for a future provider. |
| `MISTRAL_API_KEY` | *(future)* | Mistral AI API key — reserved for a future provider. |
| `ANTHROPIC_API_KEY` | *(future)* | Anthropic Claude API key — reserved for a future provider. |

The `.env` file is loaded automatically at startup using Node.js's built-in env-file loader (Node 20.12+). No external library is required.

---

## Crawl filter modes

The `crawl` object supports two mutually exclusive URL filter modes. Use **one or the other** — if both are set, `allowPatterns` takes precedence and a warning is logged.

### `ignorePatterns` — blocklist (default)

Crawl all discovered URLs **except** those whose pathname contains at least one of the listed strings.

```json
"crawl": {
  "ignorePatterns": ["/blog/", "/api/", "/fr/", "/de/"]
}
```

All paths are visited unless they match a blocked prefix/substring.

### `allowPatterns` — allowlist

Crawl **only** URLs whose pathname contains at least one of the listed strings. Everything else is silently skipped.

```json
"crawl": {
  "allowPatterns": ["/en/"]
}
```

Useful when the source site serves multiple language versions under different path prefixes (e.g. `/en/`, `/fr/`, `/de/`) and you only want to translate one of them. Combined with `pathRewrite`, you can strip the language prefix from the translated output:

```json
"crawl": {
  "allowPatterns": ["/en/"]
},
"pathRewrite": [
  { "pattern": "^/en/", "replacement": "/" }
]
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

```json
"pathRewrite": [
  { "pattern": "^/en/", "replacement": "/" }
]
```

This leaves non-English source paths (if any are accidentally crawled) untouched since the pattern only matches paths that start with `/en/`.

---

## Cross-project domain mapping

`domainMap` is an optional object that maps external domains to their translated equivalents **per target language**. Each key is an external origin; each value is an object mapping language codes to the translated domain for that language. When the translated HTML contains `<a href>` links pointing to a mapped domain, the link's origin is replaced with the value for the current target language, preserving the original pathname, query string, and fragment. If there is no entry for the current language, the link is left unchanged.

This is designed for projects that span **multiple related sites** — for example, a main website and its documentation hosted on a separate subdomain.

**Example — Astro ecosystem:**

The Astro project has two separate sites:

| Original | Translated |
|---|---|
| `https://astro.build` | `https://astro.esdocu.com` |
| `https://docs.astro.build` | `https://astro-docs.esdocu.com` |

Each site is a separate staticl10n project. To make cross-site links point to the translated siblings:

**In the `astro.build` project config:**

```json
"domainMap": {
  "https://docs.astro.build": {
    "es": "https://astro-docs.esdocu.com",
    "fr": "https://astro-docs.frdocu.com"
  }
}
```

**In the `docs.astro.build` project config:**

```json
"domainMap": {
  "https://astro.build": {
    "es": "https://astro.esdocu.com",
    "fr": "https://astro.frdocu.com"
  }
}
```

With this configuration, a link like `<a href="https://docs.astro.build/en/getting-started/">` in the Spanish translation of the main site will become `<a href="https://astro-docs.esdocu.com/en/getting-started/">`, while the French translation will point to `https://astro-docs.frdocu.com/en/getting-started/`.

> **Note:** `domainMap` only rewrites cross-project links. Internal links (same origin as `config.url`) are handled by the existing translated/untranslated link rewriting logic. If the target project also uses `pathRewrite`, the path in the mapped link is **not** rewritten — each project's `pathRewrite` applies independently to its own output.

---

## Personalization rule types

| Type | Required fields | Optional fields | Description |
|---|---|---|---|
| `remove_element` | `selector` | — | Removes all matching elements |
| `remove_attribute` | `selector`, `attribute` | — | Removes an attribute from matching elements |
| `replace_text` | `search`, `replace` | `selector` | Replaces all occurrences of a text string. Without `selector`: replaces in the entire body. With `selector`: scoped to matching elements only (e.g. `"title"` targets the `<title>` tag in `<head>`). |
| `inject_html` | `html`, `position` | — | Injects HTML at `head_end`, `body_start`, `body_end`, or `after_selector:<css>` |
| `add_attribute` | `selector`, `attribute`, `replace` | — | Sets an attribute value on matching elements |

All `postTranslation` rules also accept an optional `languages` array (e.g. `["es", "fr"]`) to restrict execution to specific language output directories. Omitting it applies the rule to all directories including `original/`.
