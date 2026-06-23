import * as cheerio from 'cheerio';
import type { HtmlFragment, PlaceholderEntry } from './extractor.js';

// ─── Translation Injector ─────────────────────────────────────────────────────

/**
 * Reconstructs HTML from placeholder-mapped translated text.
 * Replaces numbered placeholders (<1>, </1>, <2/>) with the original
 * HTML open/close tags stored in the placeholders map.
 */
function reconstructFromPlaceholders(
  translated: string,
  placeholders: Map<number, PlaceholderEntry>,
): string {
  const $ = cheerio.load(translated);

  $('[id]').each((_i, el) => {
    if (el.type === 'tag') {
      const idAttr = $(el).attr('id');
      if (idAttr) {
        const n = parseInt(idAttr, 10);
        const entry = placeholders.get(n);
        if (entry) {
          el.name = entry.name;
          el.attribs = { ...entry.attribs };
        }
      }
    }
  });

  return $('body').html() ?? translated;
}

/**
 * Injects translated fragments back into the HTML document.
 * Replaces the innerHTML of elements marked with data-sl-id.
 * Also rewrites translatable attribute values.
 */
export function injectTranslations(
  html: string,
  translatedTexts: Map<string, string>,
  fragments: HtmlFragment[],
): string {
  const $ = cheerio.load(html);

  for (const fragment of fragments) {
    const translated = translatedTexts.get(fragment.id);
    if (!translated) continue;

    if (fragment.isAttribute && fragment.elementSelector && fragment.attributeName) {
      // Update the attribute value directly
      $(fragment.elementSelector).each((_i, el) => {
        if (el.type === 'tag' && el.attribs[fragment.attributeName!] === fragment.outerHtml) {
          $(el).attr(fragment.attributeName!, translated);
        }
      });
    } else if (fragment.placeholders) {
      // Block fragment: reconstruct HTML from placeholders before injection
      const reconstructed = reconstructFromPlaceholders(translated, fragment.placeholders);
      $(`[data-sl-id="${fragment.id}"]`).each((_i, el) => {
        if (el.type === 'tag') {
          $(el).html(reconstructed);
        }
      });
    } else {
      // Fallback: no placeholders (should not happen with new strategy)
      $(`[data-sl-id="${fragment.id}"]`).each((_i, el) => {
        if (el.type === 'tag') {
          $(el).html(translated);
        }
      });
    }
  }

  return $.html();
}

/**
 * Generates the translations.js runtime patch file content for a given page.
 * This file defends translated text against React rehydration overwrites.
 */
export function generateRuntimePatch(
  fragments: HtmlFragment[],
  translatedTexts: Map<string, string>,
): string {
  // Build fragment dictionary: { "f1": "<span>Translated</span> text" }
  const fragmentDict: Record<string, string> = {};
  const attributeDict: Record<string, string> = {};

  for (const fragment of fragments) {
    const translated = translatedTexts.get(fragment.id);
    if (!translated) continue;

    if (fragment.isAttribute) {
      // Map original attribute value → translated value
      attributeDict[fragment.outerHtml] = translated;
    } else {
      // Map data-sl-id → translated innerHTML
      const $t = cheerio.load(translated);
      const firstChild = $t('body').children().first();
      const inner = (firstChild.length > 0 ? firstChild.html() : $t('body').html()) ?? translated;
      fragmentDict[fragment.id] = inner;
    }
  }

  const timestamp = new Date().toISOString();

  return `// Archivo: translations.js — generado automáticamente por staticl10n
// NO editar manualmente. Generado el: ${timestamp}
(function() {
  'use strict';

  var F = ${JSON.stringify(fragmentDict)};

  var A = ${JSON.stringify(attributeDict)};

  // Cached {el, id} pairs captured before React removes data-sl-id during hydration.
  // applyAll() uses these direct DOM references so it works even after the attribute is gone.
  var entries = [];
  var revealed = false;

  function translateAttributes(el) {
    ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'].forEach(function(attr) {
      var val = el.getAttribute(attr);
      if (val && A[val.trim()] !== undefined) {
        el.setAttribute(attr, A[val.trim()]);
      }
    });
  }

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    var tag = node.tagName && node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (node.hasAttribute('data-sl-id')) {
      var id = node.getAttribute('data-sl-id');
      if (F[id] !== undefined) node.innerHTML = F[id];
      node.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
      return;
    }
    translateAttributes(node);
    node.childNodes.forEach(walk);
  }

  // Re-applies all cached translations using stored element references.
  // Disconnects the observer first to prevent infinite mutation loops.
  function applyAll() {
    observer.disconnect();
    entries.forEach(function(e) {
      if (e.el.isConnected) e.el.innerHTML = F[e.id];
    });
    document.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    document.body.style.opacity = '1';
    var hideEl = document.getElementById('staticl10n-hide');
    if (hideEl) hideEl.remove();
  }

  function init() {
    walk(document.body);

    // Cache element references NOW, before React hydration removes data-sl-id attributes.
    document.querySelectorAll('[data-sl-id]').forEach(function(el) {
      var id = el.getAttribute('data-sl-id');
      if (id && F[id] !== undefined) entries.push({ el: el, id: id });
    });

    // Wait for React hydration to finish (browser idle), then re-apply and reveal.
    // The timeout is a fallback: requestIdleCallback won't fire until React's tasks complete.
    function afterHydration() {
      applyAll();
      reveal();
    }
    if (window.requestIdleCallback) {
      requestIdleCallback(afterHydration, { timeout: 2500 });
    } else {
      setTimeout(afterHydration, 1200);
    }
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Absolute safety net: reveal even if requestIdleCallback never fires.
  setTimeout(reveal, 5000);

  // After initial hydration, watch for React re-renders that overwrite translations.
  // If any of our tracked elements (or their children) are mutated, re-apply.
  var observer = new MutationObserver(function(mutations) {
    var needsUpdate = false;
    for (var i = 0; i < mutations.length && !needsUpdate; i++) {
      var t = mutations[i].target;
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].el === t || (entries[j].el.contains && entries[j].el.contains(t))) {
          needsUpdate = true;
          break;
        }
      }
    }
    if (needsUpdate) {
      applyAll();
    } else {
      for (var i = 0; i < mutations.length; i++) {
        mutations[i].addedNodes.forEach(function(n) {
          if (n.nodeType === Node.ELEMENT_NODE) walk(n);
        });
      }
    }
  });

  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

})();
`;
}

/**
 * Injects the anti-flicker style and the translations.js script reference into the HTML.
 * The anti-flicker style hides the body until the runtime patch reveals it.
 */
export function injectRuntimePatchReferences(html: string): string {
  const $ = cheerio.load(html);

  // Inject anti-flicker style in <head>
  $('head').append('<style id="staticl10n-hide">body{opacity:0;transition:opacity .15s}</style>');

  // Inject translations.js script just before </body>
  $('body').append('<script src="translations.js" defer></script>');

  return $.html();
}
