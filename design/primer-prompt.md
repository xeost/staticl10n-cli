# Primer prompt para el desarrollo de `staticl10n`

Desarrolla una herramienta CLI en Node.js + TypeScript llamada "staticl10n" (static localization) para capturar sitios web, convertirlos a contenido estático y traducirlos a múltiples idiomas.

---

## ARQUITECTURA GENERAL

La herramienta se estructura en:

- Una CLI interactiva con menús (usar `inquirer`)
- Una base de datos local SQLite (usar `better-sqlite3`) para estado
- Archivos de configuración JSON por proyecto
- Módulos de captura intercambiables según el tipo de sitio web (adapters)
- Módulos de traducción (inicialmente Ollama) con caché de traducciones previas
- Un sistema de etapas secuenciales por proyecto

---

## ESTRUCTURA DE DIRECTORIOS

```text
staticl10n-cli/
├── src/
│   ├── cli/
│   │   ├── index.ts              # Entry point, menú principal
│   │   ├── menus/
│   │   │   ├── projects.ts       # Gestión de proyectos
│   │   │   ├── stage1.ts         # Menú etapa 1: Captura + pre-personalización
│   │   │   ├── stage2.ts         # Menú etapa 2: Traducción
│   │   │   ├── stage3.ts         # Menú etapa 3: Post-personalización
│   │   │   └── stage4.ts         # Menú etapa 4: Monitoreo de cambios
│   ├── core/
│   │   ├── db.ts                 # Inicialización y queries SQLite
│   │   ├── config.ts             # Lectura/escritura de config JSON
│   │   └── project.ts            # Lógica de negocio de proyectos
│   ├── stages/
│   │   ├── stage1/
│   │   │   ├── crawler.ts        # Detecta todas las URLs del sitio
│   │   │   ├── downloader.ts     # Descarga assets (CSS, imágenes, fuentes)
│   │   │   ├── exporter.ts       # Ensambla el directorio estático final
│   │   │   ├── personalizer.ts   # Aplica reglas pre-traducción sobre original/
│   │   │   └── index.ts
│   │   ├── stage2/
│   │   │   ├── extractor.ts      # Extrae fragmentos HTML para traducir
│   │   │   ├── translator.ts     # Envía textos a Ollama y recibe traducción
│   │   │   ├── cache.ts          # Translation memory: evita re-traducir contenido idéntico
│   │   │   ├── injector.ts       # Inyecta traducciones en HTML + genera patch JS
│   │   │   ├── meta.ts           # Traduce meta tags, actualiza lang y genera hreflang
│   │   │   └── index.ts
│   │   ├── stage3/
│   │   │   ├── rules.ts          # Motor de reglas de post-personalización
│   │   │   └── index.ts
│   │   └── stage4/
│   │       ├── differ.ts         # Compara sitio actual vs captura guardada
│   │       ├── reporter.ts       # Genera reporte de cambios detectados
│   │       └── index.ts
│   ├── adapters/                 # Módulos intercambiables por tipo de sitio
│   │   ├── base.ts               # Interfaz/clase abstracta BaseAdapter
│   │   ├── generic.ts            # Adapter genérico para sitios estáticos (Hugo, Astro, VitePress, etc.)
│   │   └── nextjs.ts             # Lógica específica de Next.js (el más complejo)
│   └── utils/
│       ├── paths.ts              # Helpers para reescritura de rutas
│       ├── delay.ts              # Sleep con jitter para evitar bloqueos
│       └── logger.ts             # Logger con niveles y colores (usar `chalk`)
├── data/                         # Generado en runtime, ignorado en git
│   └── staticl10n.db             # Base de datos SQLite
├── projects/                     # Generado en runtime, ignorado en git
│   └── <project-slug>/
│       └── config.json           # Config de cada proyecto
├── package.json
├── tsconfig.json
└── README.md
```

---

## ESQUEMA DE BASE DE DATOS SQLITE

```sql
-- Proyectos registrados
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  config_path TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Páginas detectadas de cada proyecto
CREATE TABLE pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  url TEXT NOT NULL,
  path TEXT NOT NULL,              -- path relativo dentro del sitio
  status TEXT DEFAULT 'pending',   -- pending | crawled | captured | personalized
  last_crawled_at DATETIME,
  last_captured_at DATETIME,
  last_checked_at DATETIME,
  has_changes INTEGER DEFAULT 0,   -- flag para stage 4
  checksum TEXT,                   -- hash del contenido para detectar cambios
  UNIQUE(project_id, url)
);

-- Estado de traducción por página e idioma (independiente del status general de la página)
CREATE TABLE page_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER REFERENCES pages(id),
  language TEXT NOT NULL,
  status TEXT DEFAULT 'pending',   -- pending | translated | failed
  translated_at DATETIME,
  source_checksum TEXT,            -- checksum del HTML fuente al momento de traducir
  UNIQUE(page_id, language)
);

-- Caché de traducciones para evitar re-traducir fragmentos idénticos
CREATE TABLE translation_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  source_hash TEXT NOT NULL,       -- SHA-256 del fragmento HTML fuente
  source_text TEXT NOT NULL,       -- fragmento HTML original
  target_language TEXT NOT NULL,
  translated_text TEXT NOT NULL,   -- fragmento HTML traducido
  model TEXT NOT NULL,             -- modelo usado para la traducción
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, source_hash, target_language)
);

-- Registro de ejecuciones de cada etapa
CREATE TABLE stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  stage INTEGER NOT NULL,          -- 1, 2, 3 o 4
  status TEXT NOT NULL,            -- running | completed | failed
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  details TEXT                     -- JSON con metadata de la ejecución
);

-- Cambios detectados en stage 4
CREATE TABLE change_detections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER REFERENCES pages(id),
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  old_checksum TEXT,
  new_checksum TEXT,
  status TEXT DEFAULT 'pending'    -- pending | re-translated | ignored
);
```

---

## ESQUEMA DE CONFIGURACIÓN JSON POR PROYECTO

```json
{
  "name": "Mi Proyecto",
  "slug": "mi-proyecto",
  "url": "https://ejemplo.com",
  "targetUrls": {
    "es": "https://es.ejemplo.com",
    "fr": "https://fr.ejemplo.com"
  },
  "siteType": "nextjs",
  "crawl": {
    "delayMs": 1500,
    "delayJitterMs": 500,
    "maxPages": 500,
    "ignorePatterns": ["/api/", "/admin/", "/_next/"]
  },
  "paths": {
    "original": "/ruta/absoluta/fuera/del/repo/mi-proyecto/original",
    "raw": "/ruta/absoluta/fuera/del/repo/mi-proyecto/raw",
    "translations": {
      "es": "/ruta/absoluta/fuera/del/repo/mi-proyecto/es",
      "fr": "/ruta/absoluta/fuera/del/repo/mi-proyecto/fr"
    }
  },
  "translation": {
    "provider": "ollama",
    "ollamaUrl": "http://localhost:11434",
    "model": "llama3.1",
    "sourceLanguage": "en",
    "targetLanguages": ["es", "fr"],
    "batchSize": 20,
    "maxFragmentTokens": 2000
  },
  "personalization": {
    "preTranslation": [
      {
        "type": "remove_element",
        "selector": "script[src*='google-analytics']",
        "description": "Eliminar Google Analytics"
      },
      {
        "type": "remove_element",
        "selector": "script[src*='googletagmanager']",
        "description": "Eliminar Google Tag Manager"
      },
      {
        "type": "remove_element",
        "selector": ".cookie-banner",
        "description": "Eliminar banner de cookies original"
      }
    ],
    "postTranslation": [
      {
        "type": "inject_html",
        "position": "body_end",
        "html": "<div id='my-banner'>...</div>",
        "description": "Inyectar banner de publicidad"
      },
      {
        "type": "replace_text",
        "search": "© 2024 Original Company",
        "replace": "© 2024 Mi Empresa",
        "description": "Reemplazar copyright"
      }
    ]
  }
}
```

**Notas sobre el config:**

- `targetUrls`: Se usa para generar las etiquetas `<link rel="alternate" hreflang="...">` en cada página y para reescribir URLs canónicas. No se usa para despliegue.
- `paths.raw`: Directorio donde se guarda el HTML crudo de Playwright **antes** del procesamiento del adapter. Permite re-procesar sin re-capturar.
- `translation.maxFragmentTokens`: Límite aproximado de tokens por fragmento HTML enviado a traducir. Fragmentos que excedan este límite se dividirán en sub-fragmentos en boundaries semánticas (hijos directos del elemento).
- `personalization.preTranslation`: Reglas que se aplican al directorio `original/` al final de la Etapa 1, **antes** de traducir. Típicamente: eliminación de elementos innecesarios.
- `personalization.postTranslation`: Reglas que se aplican a todos los directorios (original + idiomas) en la Etapa 3, **después** de traducir. Típicamente: inyección de contenido propio.

---

## LAS CUATRO ETAPAS

### ETAPA 1 — Captura, exportación estática y pre-personalización

1. **Detección de URLs (crawler)**: Usando `playwright` en modo headless, visitar la URL raíz del proyecto, extraer todos los `<a href>` internos, seguirlos recursivamente respetando el delay configurado, ignorar los patrones definidos en config. Guardar cada URL encontrada en la tabla `pages` con status `pending`. Mostrar progreso en tiempo real en la CLI.

2. **Captura de cada página**: Para cada URL en la BD con status `pending` o `crawled`:
   - Abrir con Playwright. Ejecutar el hook `beforeCapture()` del adapter (si existe) para esperas específicas del framework.
   - Capturar el DOM final con `page.content()`.
   - **Guardar el HTML crudo** en el directorio `raw/` antes de cualquier procesamiento. Esto permite re-ejecutar el procesamiento del adapter sin re-capturar el sitio.
   - Ejecutar `processHTML()` del adapter sobre el HTML capturado.
   - Con `cheerio` procesar el HTML:
     - Identificar todos los assets referenciados: CSS, JS, imágenes, fuentes.
     - Para los archivos CSS descargados, analizarlos con expresiones regulares buscando referencias `url(...)` (ej. imágenes o fuentes internas) para descargarlas también.
     - Descargar cada asset usando la API de requests de Playwright (para mantener cookies/headers consistentes) y guardarlo bajo el directorio `original`.
     - Reescribir todas las rutas a paths relativos locales.

3. **Particularidades por tipo de sitio** (delegadas al adapter):
   - **generic**: Maneja la mayoría de los sitios estáticos (Hugo, Astro, VitePress, etc.) sin tratamiento especial más allá de la reescritura de paths de assets.
   - **nextjs**: Ver sección detallada más adelante. Corrige URLs `/_next/image`, maneja hidratación de React, previene SPA navigation, gestiona `next/font`, etc.

4. **Pre-personalización**: Al finalizar la captura de todas las páginas, aplicar las reglas de `personalization.preTranslation` sobre los HTML del directorio `original/`. Esto garantiza que:
   - No se envíen a traducir textos dentro de elementos que serán eliminados (ahorro de tokens de IA).
   - El contenido traducido no incluirá scripts de analytics ni otros elementos no deseados.

5. Actualizar status de cada página en BD al completar.

---

### ETAPA 2 — Traducción con Ollama

1. **Extracción de fragmentos HTML**: Con `cheerio` extraer fragmentos de HTML completos (bloques de nivel `<section>`, `<article>`, `<div>` o `<p>` con contenido textual) que contengan contenido traducible. Estrategia de extracción **greedy upward**:
   - Recorrer el DOM top-down.
   - Al encontrar un elemento con contenido textual significativo (ratio texto/markup > 60%), extraer su outerHTML completo como fragmento.
   - **No extraer hijos de un fragmento ya extraído** para evitar doble traducción.
   - Si un fragmento excede `maxFragmentTokens`, dividirlo en sus hijos directos y extraer cada uno como fragmento independiente.
   - Ignorar fragmentos que sean solo números, símbolos o whitespace.

   Exclusiones al extraer:
   - Elementos `<script>` y `<style>` completos (no enviarlos a traducir).
   - Atributos técnicos: la IA solo debe traducir contenido legible, manteniendo intactas las clases CSS, IDs y URLs.
   - Bloques `<script type="application/ld+json">` (tienen tratamiento separado como JSON).

   Agrupar fragmentos en batches según `batchSize`.

2. **Consulta de caché**: Antes de enviar un batch a la IA, calcular el SHA-256 de cada fragmento y buscar en `translation_cache`. Los fragmentos con caché válida se reutilizan directamente sin consumir tokens de IA. Solo los fragmentos sin caché se envían a traducir. Tras recibir las traducciones, guardarlas en `translation_cache` para futuros usos.

3. **Traducción y Verificación**: Enviar cada batch de fragmentos HTML nuevos a la API de Ollama (modelos como Gemma 4 son excelentes para esto). El prompt debe instruir traducir los textos manteniendo la estructura HTML intacta.
   **Verificación de integridad**: Tras recibir la respuesta, parsear el HTML traducido y compararlo con el original:
   - Debe tener exactamente la misma cantidad y tipo de elementos HTML por tag.
   - Los atributos `class`, `id`, `href`, `src` deben ser idénticos al original.
   - Si la integridad falla, descartar y reintentar la traducción (máximo 3 intentos por fragmento).

4. **Inyección dual** — El HTML traducido se aplica de dos formas complementarias:

   **a) Reemplazo directo en HTML (para el contenido estático inicial):**
   - Reemplazar los fragmentos de HTML original con los traducidos en el documento destino.
   - Esto garantiza que el primer render de la página muestre el texto traducido (bueno para SEO y primer paint).

   **b) Generación del patch de runtime `translations.js` (defensa contra hidratación de React):**
   - Comparar el HTML original y el traducido para extraer el mapeo exacto de nodos de texto e imágenes: `texto_original → texto_traducido`.
   - Generar un diccionario para `translations.js` que actúa como **capa de defensa**: cuando React re-hidrata el DOM y sobreescribe los textos traducidos con los originales en inglés, el `MutationObserver` detecta el cambio y re-aplica la traducción.
   - Este script es necesario **únicamente en sitios con frameworks JS que controlan el DOM** (como Next.js). Para sitios estáticos puros, el reemplazo directo es suficiente y no se genera `translations.js`.

   Detalle del archivo `translations.js` y su funcionamiento: ver sección "PATCH DE RUNTIME PARA TRADUCCIONES" más adelante.

5. **Manejo de meta tags y atributos de idioma**: Para cada página traducida:
   - Actualizar `<html lang="XX">` al idioma destino.
   - Traducir `<title>`, `<meta name="description">`, `<meta property="og:title">`, `<meta property="og:description">`, `<meta property="og:site_name">` y `<meta name="twitter:title">`, `<meta name="twitter:description">`.
   - Inyectar etiquetas `<link rel="alternate" hreflang="...">` en el `<head>` para todos los idiomas disponibles (incluyendo el original), usando las URLs de `targetUrls` del config:
     ```html
     <link rel="alternate" hreflang="en" href="https://ejemplo.com/about" />
     <link rel="alternate" hreflang="es" href="https://es.ejemplo.com/about" />
     <link rel="alternate" hreflang="fr" href="https://fr.ejemplo.com/about" />
     <link rel="alternate" hreflang="x-default" href="https://ejemplo.com/about" />
     ```

6. **Datos estructurados JSON-LD**: Los bloques `<script type="application/ld+json">` son valiosos para SEO. Sus textos visibles (name, description, etc.) deben traducirse procesándolos como JSON para no romper su estructura:

   ```typescript
   $('script[type="application/ld+json"]').each((_, el) => {
     try {
       const data = JSON.parse($(el).html() ?? '{}');
       const translated = translateJsonLdValues(data, translations);
       $(el).html(JSON.stringify(translated, null, 0));
     } catch {
       // Si el JSON no parsea correctamente, dejarlo intacto
       logger.warn('No se pudo procesar JSON-LD en:', pageUrl);
     }
   });
   ```

7. **Carpetas Independientes**: Guardar cada página traducida en su directorio de idioma configurado, y **copiar todos los assets** a ese directorio. Cada directorio de idioma será totalmente independiente y se publicará sin depender del directorio `original/`. Actualizar status en `page_translations` (no en `pages`). La traducción de cada página se confirma atómicamente en la BD para permitir resumir en caso de error.

---

### ETAPA 3 — Post-personalización

Aplicar las reglas del array `personalization.postTranslation` del config JSON sobre los archivos HTML del directorio `original` y de cada traducción. Estas reglas se ejecutan **después** de la traducción, sobre todos los directorios.

Tipos de regla a implementar:

- `remove_element`: Eliminar elementos que coincidan con un selector CSS (usando cheerio). Útil para elementos que solo deben eliminarse post-traducción.
- `remove_attribute`: Remover un atributo específico de elementos que coincidan con un selector.
- `replace_text`: Reemplazar un texto exacto por otro en el HTML.
- `inject_html`: Insertar HTML en una posición: `head_end`, `body_start`, `body_end`, o `after_selector:<selector>`.
- `add_attribute`: Agregar/modificar un atributo en elementos que coincidan con un selector.

**Nota**: Las reglas de tipo `remove_element` orientadas a scripts de analytics o elementos innecesarios para la traducción deben ubicarse en `personalization.preTranslation` (se aplican en Etapa 1). El array `postTranslation` es para contenido que debe inyectarse o modificarse después de la traducción.

Mostrar en CLI un resumen de cuántos elementos fueron afectados por cada regla.

---

### ETAPA 4 — Monitoreo de cambios

1. **Verificación**: Para cada URL en la BD, volver a visitar el sitio original con Playwright, capturar el HTML y calcular un checksum (SHA-256). **Evitar falsos positivos**: el checksum debe calcularse ÚNICAMENTE sobre los nodos de texto puros e imágenes visibles extraídos del DOM, excluyendo tags `<script>`, `<link>` o hashes dinámicos del bundler que cambian en cada build. Comparar con el checksum guardado.

2. **Reporte**: Listar en la CLI todas las páginas con cambios detectados, mostrando URL, fecha del último checksum y fecha de detección del cambio.
   Permitir al usuario marcar cambios como `ignored` o lanzar la re-captura y re-traducción de esa página específica.

3. **Soporte para cron**: El comando `staticl10n check <project-slug>` debe poder ejecutarse sin interacción (modo no interactivo), registrando resultados en la BD y en un log file, para poder ser invocado desde cron:

   ```text
   0 6 * * * /usr/local/bin/staticl10n check mi-proyecto >> /var/log/staticl10n.log 2>&1
   ```

---

## ADAPTER INTERFACE

```typescript
// src/adapters/base.ts
import type { Page } from 'playwright';

export interface SiteAdapter {
  name: string;

  // Detects if an HTML page / URL belongs to this site type
  detect(html: string, url: string): boolean;

  // Hook executed BEFORE capturing the HTML with page.content().
  // Receives the Playwright Page object for framework-specific waits
  // (e.g., waiting for React hydration in Next.js).
  // The generic adapter can simply return (no-op).
  beforeCapture(page: Page, projectConfig: ProjectConfig): Promise<void>;

  // Post-processes the captured HTML string before saving to disk.
  // Does NOT receive a Playwright Page — only operates on the HTML string.
  // Used for cleanup: removing prefetch links, fixing image URLs, etc.
  processHTML(html: string, pageUrl: string, projectConfig: ProjectConfig): Promise<string>;

  // Returns additional asset URLs specific to this framework that need downloading
  getAdditionalAssets(html: string, pageUrl: string): string[];

  // Rewrites asset paths in the HTML to local relative paths
  rewriteAssetPaths(html: string, assetMap: Map<string, string>): string;

  // Returns true if this site type requires the runtime translation patch (translations.js).
  // True for sites with JS frameworks that control the DOM (Next.js).
  // False for purely static sites.
  needsRuntimePatch(): boolean;
}
```

---

## MENÚ CLI

El menú principal con `inquirer` debe tener este flujo:

```text
staticl10n
│
├── Gestionar proyectos
│   ├── Listar proyectos
│   ├── Crear nuevo proyecto  →  solicita nombre, URL origen, URLs destino, tipo de sitio, paths
│   ├── Editar proyecto       →  abre config.json en el editor del sistema ($EDITOR)
│   └── Eliminar proyecto
│
├── Seleccionar proyecto activo  →  muestra lista, guarda selección en sesión
│
└── [Con proyecto activo seleccionado]:
    ├── Ver estado del proyecto  →  tabla con conteo de páginas por status + estado por idioma
    │
    ├── Etapa 1: Captura
    │   ├── Detectar URLs (crawler)
    │   ├── Capturar páginas pendientes
    │   ├── Re-capturar página específica  →  busca por URL
    │   ├── Aplicar pre-personalización (sobre original/)
    │   ├── Vista previa de pre-personalización (dry-run)
    │   └── Ver páginas capturadas
    │
    ├── Etapa 2: Traducción
    │   ├── Traducir todas las páginas capturadas
    │   ├── Traducir páginas pendientes de traducción
    │   ├── Re-traducir página específica
    │   ├── Ver estado de traducciones por idioma
    │   └── Ver estadísticas de caché (hits/misses)
    │
    ├── Etapa 3: Post-personalización
    │   ├── Aplicar reglas de post-personalización
    │   ├── Vista previa de reglas (dry-run, sin modificar archivos)
    │   └── Ver reglas configuradas
    │
    └── Etapa 4: Monitoreo
        ├── Verificar cambios en el sitio original
        ├── Ver páginas con cambios detectados
        ├── Re-procesar página con cambios
        └── Marcar cambios como ignorados
```

---

## CONSIDERACIONES TÉCNICAS

- Usar `tsx` para ejecutar TypeScript directamente en desarrollo
- El binario CLI se registra en `package.json` bajo `bin.staticl10n`
- Toda operación larga debe mostrar un spinner (`ora`) y progreso (`cli-progress`)
- Los errores de red en captura/traducción deben reintentarse con backoff exponencial (máximo 3 intentos)
- El delay entre requests debe incluir jitter aleatorio para ser menos predecible: `delay = baseDelayMs + random(0, jitterMs)`
- Playwright debe correr en modo headless, con user-agent de browser real
- Los logs de cada ejecución deben guardarse en `data/logs/` con timestamp
- El proyecto debe tener un `README.md` completo con instrucciones de instalación y uso
- Todas las etapas deben soportar un modo `--dry-run` que muestre qué se haría sin ejecutar cambios
- La descarga de assets debe usar la API de requests de Playwright (no `fetch` externo) para mantener cookies y headers consistentes con la sesión del navegador
- El guardado de estado en BD debe ser atómico por página para permitir resumir operaciones interrumpidas

---

## DEPENDENCIAS PRINCIPALES

```json
{
  "dependencies": {
    "inquirer": "^10",
    "better-sqlite3": "^9",
    "playwright": "^1.44",
    "cheerio": "^1.0",
    "chalk": "^5",
    "ora": "^8",
    "cli-progress": "^3",
    "commander": "^12",
    "fs-extra": "^11"
  },
  "devDependencies": {
    "typescript": "^5",
    "tsx": "^4",
    "@types/node": "^20",
    "@types/better-sqlite3": "^7",
    "@types/fs-extra": "^11",
    "@types/inquirer": "^9"
  }
}
```

**Notas sobre dependencias:**

- Se usa la API de requests de Playwright para descargas HTTP en lugar de `axios` o `fetch` externo, manteniendo consistencia de sesión (cookies, headers).
- `commander` se usa para los comandos no interactivos (ej. `staticl10n check <slug>`). `inquirer` se usa exclusivamente para el modo interactivo con menús.

Genera el proyecto completo con todos los archivos, tipos TypeScript estrictos, manejo de errores robusto y comentarios explicativos en el código. El código debe estar en español donde sea apropiado (comentarios, mensajes de la CLI, logs) pero los identificadores (variables, funciones, clases) en inglés siguiendo convenciones estándar de TypeScript.

---

## ADAPTER: NEXT.JS — PARTICULARIDADES Y COMPORTAMIENTO ESPERADO

Esta sección describe el comportamiento específico que debe implementar `src/adapters/nextjs.ts`. Es el adapter más complejo dado el modelo de hidratación de React/Next.js.

---

### DETECCIÓN DE SITIOS NEXT.JS

El método `detect()` debe identificar un sitio Next.js verificando la presencia de cualquiera de estas señales en el HTML:

- Existencia del elemento `<script id="__NEXT_DATA__">` (Pages Router)
- Scripts con src que contengan `/_next/static/`
- Meta tag `<meta name="generator" content="Next.js">`
- Presencia de payloads RSC inline: scripts que contengan `self.__next_f.push(...)` (App Router)
- Atributo `data-nextjs-scroll-focus-boundary` en algún elemento

---

### EL PROBLEMA CENTRAL: HIDRATACIÓN DE REACT

Next.js, independientemente del modo de renderizado (SSG, SSR, ISR o CSR), sigue este ciclo que hace que editar el HTML del servidor sea insuficiente:

1. El servidor entrega HTML estático ya renderizado (para SEO y primer paint)
2. El browser descarga los bundles JS de React + Next.js
3. React ejecuta un proceso llamado "hidratación": recorre el DOM existente y lo "adopta", adjuntando event listeners y estado interno
4. A partir de ese momento React controla el DOM completamente
5. Cualquier re-render posterior (navegación, interacción, estado) es generado por React desde JS, reemplazando el contenido del DOM

Por esto, traducir solo el HTML del servidor no es suficiente: React sobreescribirá esos textos con los originales en inglés durante la hidratación. La solución implementada en esta herramienta es la **inyección dual**: reemplazo directo del HTML + patch de runtime con `translations.js` que actúa como defensa contra la rehidratación.

---

### HOOK `beforeCapture()` — ESPERA PARA PLAYWRIGHT

El adapter Next.js implementa `beforeCapture()` para ejecutar esperas específicas antes de capturar el DOM. Esta lógica opera sobre el objeto `Page` de Playwright (no sobre un string HTML):

```typescript
async beforeCapture(page: Page, config: ProjectConfig): Promise<void> {
  await page.waitForLoadState('networkidle');
  // Espera adicional para hidratación completa de React
  await page.waitForFunction(() => {
    return document.querySelector('[data-nextjs-scroll-focus-boundary]') !== null
      || document.readyState === 'complete';
  });
  // Jitter adicional configurable (default 800ms) para JS post-hydration
  await delay(config.crawl.postHydrationDelayMs ?? 800);
}
```

Tras completar `beforeCapture()`, el flujo principal captura el DOM con `page.content()`.

---

### MÉTODO `processHTML()` — PROCESAMIENTO DEL HTML CAPTURADO

Este método recibe el HTML como string (ya capturado) y realiza el post-procesamiento específico de Next.js:

#### Manejo de scripts específicos

Aunque se conservan los scripts para mantener la interactividad, algunos requieren atención especial:

- `<script id="__NEXT_DATA__">`: Contiene el JSON con los props iniciales de la página (Pages Router). Guardarlo en un archivo separado `__next_data__.json` en el directorio de la página por si se necesita para análisis futuro.
- `<script type="application/ld+json">`: Son datos estructurados para SEO (Schema.org). CONSERVAR, no son código ejecutable, son metadata valiosa para buscadores.

#### Eliminación de prefetch y preload de Next.js

Estos tags ya no tienen utilidad sin el servidor de Next.js y generarán errores 404 en el servidor estático:

```typescript
// Eliminar con cheerio:
$('link[rel="preload"][as="script"]').remove();
$('link[rel="prefetch"]').remove();
$('link[rel="modulepreload"]').remove();
// Conservar: link[rel="stylesheet"], link[rel="icon"], link[rel="canonical"]
```

#### Prevención de navegación SPA (forzar navegación tradicional)

Para que Next.js no intercepte la navegación (SPA) y provoque errores al intentar cargar chunks JSON/JS que no fueron descargados, debemos deshabilitarlo:

```typescript
// Inyectar un script global en el <head> para forzar la recarga en los clicks
const preventSPAScript = `
  <script>
    document.addEventListener('click', function(e) {
      var link = e.target.closest('a');
      if (link && link.href && link.origin === location.origin) {
        e.preventDefault();
        e.stopImmediatePropagation();
        window.location.href = link.href;
      }
    }, true);
  </script>
`;
$('head').prepend(preventSPAScript);
```

**Nota**: Se usa `preventDefault()` + `stopImmediatePropagation()` + `window.location.href` explícito para garantizar que el browser maneje la navegación de forma nativa, independientemente de cómo Next.js registre sus event handlers internos. `stopPropagation()` solo no es suficiente porque React usa un sistema de eventos sintéticos.

#### Retorno de `needsRuntimePatch()`

El adapter Next.js devuelve `true` en `needsRuntimePatch()`, indicando que las páginas traducidas requieren el archivo `translations.js` para defender los textos traducidos contra la rehidratación de React.

---

### MANEJO DE IMÁGENES: EL COMPONENTE `<Image>` DE NEXT.JS

El componente `<Image>` de Next.js transforma las URLs de imágenes al formato `/_next/image?url=<url_original>&w=<ancho>&q=<calidad>`.
Este endpoint de optimización no existirá en el servidor estático.

El adapter debe detectar y corregir estos casos:

```typescript
function rewriteNextImageSrc(src: string): string {
  // Detectar patrón /_next/image?url=...
  if (src.includes('/_next/image')) {
    const params = new URLSearchParams(src.split('?')[1]);
    const originalUrl = params.get('url');
    if (originalUrl) {
      // Puede ser una URL absoluta o un path relativo al dominio
      return decodeURIComponent(originalUrl);
    }
  }
  return src;
}

// Aplicar a todos los atributos src e srcset de imágenes
$('img').each((_, el) => {
  const src = $(el).attr('src');
  if (src) $(el).attr('src', rewriteNextImageSrc(src));

  const srcset = $(el).attr('srcset');
  if (srcset) {
    const rewritten = srcset
      .split(',')
      .map(entry => {
        const [url, descriptor] = entry.trim().split(' ');
        return `${rewriteNextImageSrc(url)} ${descriptor ?? ''}`.trim();
      })
      .join(', ');
    $(el).attr('srcset', rewritten);
  }
});
```

Adicionalmente, Next.js genera un `<noscript>` con una versión fallback de cada imagen. Eliminarlos ya que generan duplicados:

```typescript
// El noscript de Next.js Image siempre contiene un <img> con data-nimg
$('noscript').each((_, el) => {
  if ($(el).html()?.includes('data-nimg')) $(el).remove();
});
```

---

### MANEJO DE CSS

Next.js puede servir CSS de dos formas distintas:

**CSS Modules y CSS global (archivos .css externos):**
Se referencian como `<link href="/_next/static/css/[hash].css">`.
Estos archivos deben descargarse y sus rutas reescritas a paths locales relativos. Son archivos CSS normales que funcionan sin JS.

**CSS-in-JS (styled-components, Emotion, o el propio sistema de Next.js):**
Next.js inyecta estos estilos como `<style>` tags directamente en el `<head>` durante el SSR/SSG. Al capturar con Playwright el DOM hidratado, estos `<style>` tags ya están presentes en el HTML.
No requieren ningún tratamiento especial, quedan embebidos en el HTML.

Verificar ambos casos y documentar cuál aplica al proyecto en el log de captura.

---

### MANEJO DE `next/font`

Next.js optimiza fuentes a través de `next/font`, que genera archivos de fuente autoalojados bajo `/_next/static/media/`. El adapter debe:

1. Detectar archivos de fuente referenciados en CSS bajo `/_next/static/media/` (formatos `.woff2`, `.woff`, `.ttf`).
2. Incluirlos en la lista de assets a descargar via `getAdditionalAssets()`.
3. Reescribir las declaraciones `@font-face` en el CSS descargado para apuntar a las rutas locales relativas.

```typescript
// En getAdditionalAssets(): detectar fuentes en los CSS inline y externos
const fontUrls: string[] = [];
$('style').each((_, el) => {
  const css = $(el).html() ?? '';
  const fontMatches = css.matchAll(/url\(["']?([\/_next][^"')]+\.woff2?)["']?\)/g);
  for (const match of fontMatches) {
    fontUrls.push(new URL(match[1], pageUrl).href);
  }
});
```

---

### PATCH DE RUNTIME PARA TRADUCCIONES

Esta es la pieza clave que permite mantener la interactividad de Next.js mientras se muestran los textos traducidos. Funciona como **capa de defensa contra la rehidratación de React**:

1. El HTML de la página ya contiene los textos traducidos (reemplazo directo en la Etapa 2)
2. Los scripts de Next.js se conservan para mantener la interactividad
3. React re-hidrata el DOM y sobreescribe los textos traducidos con los originales en inglés
4. El `MutationObserver` del patch detecta estos cambios y re-aplica las traducciones

**Anti-flicker**: Para evitar que el usuario vea brevemente los textos en inglés durante la rehidratación, se inyecta un `<style>` en el `<head>` del HTML que oculta el body hasta que el patch haya aplicado las traducciones:

```html
<!-- Inyectado en el <head> por Stage 2 -->
<style id="staticl10n-hide">body{opacity:0;transition:opacity .1s}</style>
```

El archivo `translations.js`:

```javascript
// Archivo: translations.js — generado automáticamente por staticl10n
// NO editar manualmente. Generado el: {{timestamp}}
(function() {
  'use strict';

  // Diccionario generado por la IA: { "texto original en inglés": "texto traducido" }
  // Solo contiene textos que React podría sobreescribir durante la rehidratación
  const T = {{TRANSLATIONS_JSON}};

  // Traduce un nodo de texto individual.
  // Compara el texto completo (trimmed) contra el diccionario, no substrings.
  function translateTextNode(node) {
    const trimmed = node.textContent.trim();
    if (trimmed && T[trimmed] !== undefined) {
      // Preservar whitespace original (espacios, saltos de línea al inicio/final)
      const leading = node.textContent.match(/^\s*/)[0];
      const trailing = node.textContent.match(/\s*$/)[0];
      node.textContent = leading + T[trimmed] + trailing;
    }
  }

  // Traduce atributos traducibles de un elemento
  function translateAttributes(el) {
    ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'].forEach(function(attr) {
      var val = el.getAttribute(attr);
      if (val && T[val.trim()] !== undefined) {
        el.setAttribute(attr, T[val.trim()]);
      }
    });
  }

  // Recorre el subárbol DOM a partir de un nodo
  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      translateTextNode(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // No procesar scripts ni estilos
      var tag = node.tagName && node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
      translateAttributes(node);
      node.childNodes.forEach(walk);
    }
  }

  // Función para revelar el contenido tras la traducción inicial
  function reveal() {
    document.body.style.opacity = '1';
    var hideEl = document.getElementById('staticl10n-hide');
    if (hideEl) hideEl.remove();
  }

  // Traducción inicial del DOM ya cargado + revelar
  if (document.body) {
    walk(document.body);
    reveal();
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      walk(document.body);
      reveal();
    });
  }

  // Safety timeout: si el script tarda más de 2s, mostrar el contenido de todas formas
  setTimeout(reveal, 2000);

  // Observar cambios futuros del DOM para cubrir re-renders de React.
  // Esto es lo que hace funcionar la traducción en componentes interactivos
  // como modales, tabs, acordeones, dropdowns, etc.
  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      // Nodos nuevos agregados al DOM (re-renders de React)
      mutation.addedNodes.forEach(function(node) {
        walk(node);
      });
      // Cambios de texto en nodos existentes (React actualizando textContent)
      if (mutation.type === 'characterData') {
        translateTextNode(mutation.target);
      }
    });
  });

  observer.observe(document.body, {
    childList: true,      // Detecta nodos agregados/removidos
    subtree: true,        // En todo el subárbol, no solo hijos directos
    characterData: true   // Detecta cambios de texto en nodos existentes
  });

})();
```

Este archivo se inyecta en el HTML de cada idioma de destino calculando la ruta relativa dinámicamente según la profundidad de la URL (ej. `../../translations.js`):

```html
<script src="../../translations.js" defer></script>
```

ubicado justo antes del `</body>` de cada página traducida.

**Limitaciones conocidas del patch de runtime:**

- **Text fragmentation**: React puede dividir texto en múltiples nodos (ej. `"Hello, "` + `userName` + `"!"`). El diccionario no cubre estos fragmentos parciales. El impacto es bajo en sitios de contenido.
- **Texto dinámico**: Contadores, fechas, contenido generado por el usuario no estarán en el diccionario. Esto es inherentemente imposible de cubrir sin traducción en runtime.
- **Flicker mínimo**: Aunque el anti-flicker oculta el body inicialmente, puede haber micro-flickers en re-renders posteriores (ej. abrir un modal). El MutationObserver actúa en el siguiente microtask, por lo que el flicker es generalmente imperceptible.

---

### EXTRACCIÓN DE HTML PARA TRADUCCIÓN

En lugar de extraer nodos de texto sueltos, se extraen fragmentos de HTML completos. Al enviar estos fragmentos a la IA, el adapter debe excluir o sanitizar previamente:

- Excluir elementos `<script>` y `<style>` completos (no enviarlos a traducir).
- Ignorar fragmentos que sean solo números, símbolos o whitespace.
- Excluir atributos técnicos, asegurando que la IA solo traduzca contenido legible y mantenga intactas las clases CSS, IDs y URLs.
- Bloques `<script type="application/ld+json">` ya que tienen su propio tratamiento (sus valores de texto sí se traducen pero parseándolos como JSON).

**Justificación**: Enviar HTML fragments en lugar de nodos de texto individuales permite que el modelo de IA vea el contexto completo de cada frase y pueda reordenar elementos cuando el idioma lo requiere. Ejemplo:

- Inglés: `<p>Awesome <span>world</span>!</p>`
- Español: `<p><span>Mundo</span> asombroso!</p>`

Con nodos de texto sueltos (`"Awesome "`, `"world"`, `"!"`), el modelo no tendría forma de saber que el orden cambia. Con el fragmento HTML completo, puede reorganizar los elementos preservando la semántica y el markup.

---

### ESTRUCTURA DE ASSETS EN EL DIRECTORIO DE SALIDA

Para una página Next.js capturada y traducida, cada entorno será totalmente independiente. La estructura local de salida será así:

```text
├── raw/                           ← HTML crudo de Playwright (sin procesar)
│   ├── index.html
│   └── about/index.html
│
├── original/                      ← HTML procesado por el adapter + pre-personalizado
│   ├── index.html
│   ├── about/index.html
│   └── _assets/                   ← todos los assets descargados
│
├── es/                            ← Carpeta independiente
│   ├── index.html                 ← HTML con textos traducidos + style anti-flicker
│   ├── translations.js            ← script de diccionario para runtime patch
│   ├── about/index.html
│   └── _assets/                   ← COPIA COMPLETA e independiente de todos los assets
│
└── fr/
    ├── index.html
    ├── translations.js
    └── _assets/                   ← COPIA COMPLETA e independiente
```

Cada directorio (original, es, fr) se publicará en su respectivo dominio de forma aislada. Todas las rutas en los HTML deben ser relativas (usando `../` según la profundidad de la página) para que siempre referencien a su propia carpeta `_assets/` local.
