# Primer prompt para el desarrollo de `staticl10n`

Desarrolla una herramienta CLI en Node.js + TypeScript llamada "staticl10n" (static localization) para capturar sitios web, convertirlos a contenido estático y traducirlos a múltiples idiomas.

---

## ARQUITECTURA GENERAL

La herramienta se estructura en:

- Una CLI interactiva con menús (usar `inquirer`)
- Una base de datos local SQLite (usar `better-sqlite3`) para estado
- Archivos de configuración JSON por proyecto
- Módulos de captura intercambiables según el tipo de sitio web
- Módulos de traducción (inicialmente Ollama)
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
│   │   │   ├── stage1.ts         # Menú etapa 1: Captura
│   │   │   ├── stage2.ts         # Menú etapa 2: Traducción
│   │   │   ├── stage3.ts         # Menú etapa 3: Personalización
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
│   │   │   └── index.ts
│   │   ├── stage2/
│   │   │   ├── extractor.ts      # Extrae textos del HTML para traducir
│   │   │   ├── translator.ts     # Envía textos a Ollama y recibe traducción
│   │   │   ├── injector.ts       # Inyecta traducciones en HTML + genera patch JS
│   │   │   └── index.ts
│   │   ├── stage3/
│   │   │   ├── rules.ts          # Motor de reglas de personalización
│   │   │   └── index.ts
│   │   └── stage4/
│   │       ├── differ.ts         # Compara sitio actual vs captura guardada
│   │       ├── reporter.ts       # Genera reporte de cambios detectados
│   │       └── index.ts
│   ├── adapters/                 # Módulos intercambiables por tipo de sitio
│   │   ├── base.ts               # Interfaz/clase abstracta BaseAdapter
│   │   ├── nextjs.ts             # Lógica específica de Next.js
│   │   ├── astro.ts              # Lógica específica de Astro
│   │   ├── hugo.ts               # Lógica específica de Hugo
│   │   └── vitepress.ts          # Lógica específica de VitePress
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
  status TEXT DEFAULT 'pending',   -- pending | crawled | captured | translated | personalized
  last_crawled_at DATETIME,
  last_captured_at DATETIME,
  last_translated_at DATETIME,
  last_checked_at DATETIME,
  has_changes INTEGER DEFAULT 0,   -- flag para stage 4
  checksum TEXT,                   -- hash del contenido para detectar cambios
  UNIQUE(project_id, url)
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
    "batchSize": 20
  },
  "personalization": {
    "rules": [
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
        "type": "inject_html",
        "position": "body_end",
        "html": "<div id='my-banner'>...</div>",
        "description": "Inyectar banner de publicidad"
      }
    ]
  }
}
```

---

## LAS CUATRO ETAPAS

### ETAPA 1 — Captura y exportación estática

1. **Detección de URLs (crawler)**: Usando `playwright` en modo headless, visitar la URL raíz del proyecto, extraer todos los `<a href>` internos, seguirlos recursivamente respetando el delay configurado, ignorar los patrones definidos en config. Guardar cada URL encontrada en la tabla `pages` con status `pending`. Mostrar progreso en tiempo real en la CLI.

2. **Captura de cada página**: Para cada URL en la BD con status `pending` o `crawled`, abrir con Playwright esperar `networkidle`. Capturar el DOM final con `page.content()`. Con `cheerio` procesar el HTML:
   - Identificar todos los assets referenciados en el HTML: CSS, JS, imágenes, fuentes.
   - Para los archivos CSS descargados, analizarlos con expresiones regulares buscando referencias `url(...)` (ej. imágenes o fuentes internas) para descargarlas también.
   - Descargar cada asset y guardarlo localmente bajo el directorio `original`.
   - Reescribir todas las rutas a paths relativos locales.

3. **Particularidades por tipo de sitio** (delegadas al adapter):
   - **nextjs**: Corregir URLs `/_next/image?url=` extrayendo la imagen original del parámetro `url`. Identificar el objeto `__NEXT_DATA__` embebido en `<script id="__NEXT_DATA__">` y guardarlo como referencia.
   - **astro**: Manejar el prefijo `/_astro/` para assets.
   - **hugo**: Manejar estructura de directorios `/public/`.
   - **vitepress**: Manejar assets bajo `/.vitepress/dist/`.

4. Actualizar status de cada página en BD al completar.

---

### ETAPA 2 — Traducción con Ollama

1. **Extracción de HTML**: Con `cheerio` extraer fragmentos de HTML directos (ej. bloques de nivel `<section>`, `<div>` o `<p>`) que contengan contenido traducible. Agrupar en batches según `batchSize`.

2. **Traducción y Verificación**: Enviar cada batch de fragmentos HTML a la API de Ollama (modelos como Gemma 4 son excelentes para esto). El prompt debe instruir traducir los textos manteniendo la estructura HTML intacta.
   **Verificación de integridad**: Tras recibir la respuesta, parsear el HTML traducido y compararlo con el original. Debe tener exactamente la misma cantidad y tipo de elementos HTML. Si la integridad falla, descartar y reintentar la traducción.

3. **Inyección dual**:
   - Reemplazar los fragmentos de HTML original con los traducidos en el documento destino.
   - Comparar el HTML original y el traducido para extraer el mapeo exacto de los nodos de texto e imágenes (Texto original -> Texto traducido) y así generar un diccionario seguro para el archivo `translations.js`:

     ```js
     // Generado automáticamente — no editar manualmente
     (function() {
       const T = { "Original text": "Texto traducido", ... };
       function walk(n) {
         if (n.nodeType === 3) {
           const t = n.textContent.trim();
           if (T[t]) n.textContent = n.textContent.replace(t, T[t]);
         } else { n.childNodes.forEach(walk); }
       }
       walk(document.body);
       new MutationObserver(ms => ms.forEach(m => 
         m.addedNodes.forEach(walk)
       )).observe(document.body, { childList: true, subtree: true });
     })();
     ```

   - Inyectar el script `translations.js` al final del `<body>`. La ruta debe calcularse dinámicamente según la profundidad (ej. `../../translations.js` o `/translations.js`).

4. **Carpetas Independientes**: Guardar cada página traducida en su directorio de idioma configurado, y **copiar todos los assets** a ese directorio. Cada directorio de idioma será totalmente independiente y se publicará sin depender del directorio `original/`. Actualizar status en BD.

---

### ETAPA 3 — Personalización

Aplicar las reglas del array `personalization.rules` del config JSON sobre los archivos HTML del directorio `original` y de cada traducción. Tipos de regla a implementar:

- `remove_element`: Eliminar elementos que coincidan con un selector CSS (usando cheerio). Útil para analytics, chat widgets, etc.
- `remove_attribute`: Remover un atributo específico de elementos que coincidan con un selector.
- `replace_text`: Reemplazar un texto exacto por otro en el HTML.
- `inject_html`: Insertar HTML en una posición: `head_end`, `body_start`, `body_end`, o `after_selector:<selector>`.
- `add_attribute`: Agregar/modificar un atributo en elementos que coincidan con un selector.

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
export interface SiteAdapter {
  name: string;
  
  // Detecta si una URL/respuesta pertenece a este tipo de sitio
  detect(html: string, url: string): boolean;
  
  // Post-procesa el HTML capturado por Playwright antes de guardarlo
  processHTML(html: string, pageUrl: string, projectConfig: ProjectConfig): Promise<string>;
  
  // Retorna lista de assets adicionales a descargar específicos de este framework
  getAdditionalAssets(html: string, pageUrl: string): string[];
  
  // Reescribe rutas de assets al formato local
  rewriteAssetPaths(html: string, assetMap: Map<string, string>): string;
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
    ├── Ver estado del proyecto  →  tabla con conteo de páginas por status
    │
    ├── Etapa 1: Captura
    │   ├── Detectar URLs (crawler)
    │   ├── Capturar páginas pendientes
    │   ├── Re-capturar página específica  →  busca por URL
    │   └── Ver páginas capturadas
    │
    ├── Etapa 2: Traducción
    │   ├── Traducir todas las páginas capturadas
    │   ├── Traducir páginas pendientes de traducción
    │   ├── Re-traducir página específica
    │   └── Ver estado de traducciones por idioma
    │
    ├── Etapa 3: Personalización
    │   ├── Aplicar reglas de personalización
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
    "axios": "^1.6",
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

Genera el proyecto completo con todos los archivos, tipos TypeScript estrictos, manejo de errores robusto y comentarios explicativos en el código. El código debe estar en español donde sea apropiado (comentarios, mensajes de la CLI, logs) pero los identificadores (variables, funciones, clases) en inglés siguiendo convenciones estándar de TypeScript.

---

## ADAPTER: NEXT.JS — PARTICULARIDADES Y COMPORTAMIENTO ESPERADO

Esta sección describe el comportamiento específico que debe implementar `src/adapters/nextjs.ts`. Es el adapter más complejo dado el modelo de hidratación de React/Next.js.

---

### DETECCIÓN DE SITIOS NEXT.JS

El método `detect()` debe identificar un sitio Next.js verificando la presencia de cualquiera de estas señales en el HTML:

- Existencia del elemento `<script id="__NEXT_DATA__">`
- Scripts con src que contengan `/_next/static/`
- Meta tag `<meta name="generator" content="Next.js">`
- Atributo `data-nextjs-scroll-focus-boundary` en algún elemento

---

### EL PROBLEMA CENTRAL: HIDRATACIÓN DE REACT

Next.js, independientemente del modo de renderizado (SSG, SSR, ISR o CSR), sigue este ciclo que hace que editar el HTML del servidor sea insuficiente:

1. El servidor entrega HTML estático ya renderizado (para SEO y primer paint)
2. El browser descarga los bundles JS de React + Next.js
3. React ejecuta un proceso llamado "hidratación": recorre el DOM existente y lo "adopta", adjuntando event listeners y estado interno
4. A partir de ese momento React controla el DOM completamente
5. Cualquier re-render posterior (navegación, interacción, estado) es generado por React desde JS, reemplazando el contenido del DOM

Por esto, traducir solo el HTML del servidor no es suficiente: React sobreescribirá esos textos con los originales en inglés durante la hidratación. La solución implementada en esta herramienta es el "patch de runtime" descrito más adelante.

---

### CAPTURA CON PLAYWRIGHT

Al capturar una página Next.js, el adapter debe seguir estos pasos en orden dentro del método `processHTML()`:

#### 1. Espera adecuada antes de capturar

No basta con esperar `networkidle`. Next.js puede seguir ejecutando código después de que la red se calma. Usar la siguiente estrategia de espera combinada:

```typescript
await page.waitForLoadState('networkidle');
// Espera adicional para hidratación completa de React
await page.waitForFunction(() => {
  return document.querySelector('[data-nextjs-scroll-focus-boundary]') !== null
    || document.readyState === 'complete';
});
// Jitter adicional configurable (default 800ms) para JS post-hydration
await delay(config.crawl.postHydrationDelayMs ?? 800);
```

#### 2. Captura del DOM hidratado final

```typescript
const html = await page.content(); // DOM post-hidratación
```

Este HTML ya contiene el estado final que el usuario ve, no el HTML original del servidor. Es sobre este HTML que se trabaja.

---

### PROCESAMIENTO DEL HTML CAPTURADO

#### Manejo de scripts específicos

Aunque se conservan los scripts para mantener la interactividad, algunos requieren atención especial:

- `<script id="__NEXT_DATA__">`: Contiene el JSON con los props iniciales de la página. Guardarlo en un archivo separado `__next_data__.json` en el directorio de la página por si se necesita para análisis futuro.
- `<script type="application/ld+json">`: Son datos estructurados para SEO (Schema.org). CONSERVAR, no son código ejecutable, son metadata valiosa para buscadores.

#### Eliminación de prefetch y preload de Next.js

Estos tags ya no tienen utilidad sin el JS de Next.js y generarán errores 404 en el servidor estático:

```typescript
// Eliminar con cheerio:
$('link[rel="preload"][as="script"]').remove();
$('link[rel="prefetch"]').remove();
$('link[rel="modulepreload"]').remove();
// Conservar: link[rel="stylesheet"], link[rel="icon"], link[rel="canonical"]
```

#### Corrección del enrutador de Next.js (Forzar navegación tradicional)

Para que Next.js no intercepte la navegación (SPA) y provoque errores al intentar cargar chunks JSON/JS que no fueron descargados, debemos deshabilitarlo en los links:

```typescript
// Limpiar atributos inyectados por el router
$('a[data-discover]').removeAttr('data-discover');

// Inyectar un script global en el <head> para forzar la recarga en los clicks
const preventSPAScript = `
  <script>
    document.addEventListener('click', function(e) {
      const link = e.target.closest('a');
      if (link && link.href && link.origin === location.origin) {
        e.stopPropagation(); // Evitar que Next.js capture el click
      }
    }, true);
  </script>
`;
$('head').prepend(preventSPAScript);
```

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

### PATCH DE RUNTIME PARA TRADUCCIONES

Esta es la pieza clave que permite mantener la interactividad de Next.js mientras se muestran los textos traducidos. El problema a resolver es el siguiente:

1. El HTML capturado ya tiene textos en español (traducción directa)
2. Como se conservan los scripts de Next.js para mantener la interactividad, React re-hidrata el DOM y sobreescribe los textos con los originales en inglés.

El patch de runtime actúa como una capa de traducción que opera sobre el DOM en tiempo real y soluciona este problema:

```javascript
// Archivo: translations.js — generado automáticamente por staticl10n
// NO editar manualmente. Generado el: {{timestamp}}
(function() {
  'use strict';

  // Diccionario generado por la IA: { "texto original": "texto traducido" }
  const T = {{TRANSLATIONS_JSON}};

  // Traduce un nodo de texto individual
  function translateTextNode(node) {
    const original = node.textContent.trim();
    if (original && T[original] !== undefined) {
      // Preservar whitespace original (espacios, saltos de línea)
      node.textContent = node.textContent.replace(original, T[original]);
    }
  }

  // Traduce atributos traducibles de un elemento
  function translateAttributes(el) {
    ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'].forEach(attr => {
      const val = el.getAttribute(attr);
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
      const tag = node.tagName?.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
      translateAttributes(node);
      node.childNodes.forEach(walk);
    }
  }

  // Traducción inicial del DOM ya cargado
  if (document.body) {
    walk(document.body);
  } else {
    document.addEventListener('DOMContentLoaded', () => walk(document.body));
  }

  // Observar cambios futuros del DOM para cubrir re-renders de React
  // Esto es lo que hace funcionar la traducción en componentes interactivos
  // como modales, tabs, acordeones, dropdowns, etc.
  const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      // Nodos nuevos agregados al DOM (re-renders de React)
      mutation.addedNodes.forEach(function(node) {
        walk(node);
      });
      // Cambios de texto en nodos existentes
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

---

### EXTRACCIÓN DE HTML PARA TRADUCCIÓN

En lugar de extraer nodos de texto sueltos, se extraen fragmentos de HTML completos. Al enviar estos fragmentos a la IA, el adapter debe excluir o sanitizar previamente:

- Excluir elementos `<script>` y `<style>` completos (no enviarlos a traducir).
- Ignorar fragmentos que sean solo números, símbolos o whitespace.
- Excluir atributos técnicos, asegurando que la IA solo traduzca contenido legible y mantenga intactas las clases CSS, IDs y URLs.
- Bloques `<script type="application/ld+json">` ya que tienen su propio tratamiento (sus valores de texto sí se traducen pero parseándolos como JSON).

Los datos estructurados JSON-LD son valiosos para SEO y sus textos visibles (name, description, etc.) sí deben traducirse, pero procesándolos como JSON para no romper su estructura:

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

---

### ESTRUCTURA DE ASSETS EN EL DIRECTORIO DE SALIDA

Para una página Next.js capturada y traducida, cada entorno será totalmente independiente. La estructura local de salida será así:

```text
├── original/
│   ├── index.html
│   ├── about/index.html
│   └── _assets/                 ← todos los assets descargados
│
├── es/                          ← Carpeta independiente
│   ├── index.html
│   ├── translations.js          ← script de diccionario para runtime patch
│   ├── about/index.html
│   └── _assets/                 ← COPIA COMPLETA e independiente de todos los assets
│
└── fr/
    ├── index.html
    ├── translations.js
    └── _assets/                 ← COPIA COMPLETA e independiente
```

Cada directorio (original, es, fr) se publicará en su respectivo dominio de forma aislada. Todas las rutas en los HTML deben ser relativas (usando `../` según la profundidad de la página) para que siempre referencien a su propia carpeta `_assets/` local.
