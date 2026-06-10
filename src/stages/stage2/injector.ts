import * as cheerio from 'cheerio';
import type { HtmlFragment } from './extractor.js';

// ─── Translation Injector ─────────────────────────────────────────────────────

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
    } else {
      // Replace innerHTML of the element with data-sl-id
      $(`[data-sl-id="${fragment.id}"]`).each((_i, el) => {
        if (el.type === 'tag') {
          // Replace inner HTML with the translated fragment's inner HTML
          const $translated = cheerio.load(translated);
          const innerHtml = $translated.root().children().first().html() ?? translated;
          $(el).html(innerHtml);
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
      const inner = $t.root().children().first().html() ?? translated;
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

  function translateFragment(el) {
    var id = el.getAttribute('data-sl-id');
    if (id && F[id] !== undefined) {
      el.innerHTML = F[id];
    }
  }

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
      translateFragment(node);
      node.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
      return;
    }

    translateAttributes(node);
    node.childNodes.forEach(walk);
  }

  function reveal() {
    document.body.style.opacity = '1';
    var hideEl = document.getElementById('staticl10n-hide');
    if (hideEl) hideEl.remove();
  }

  function init() {
    walk(document.body);
    if (window.requestIdleCallback) {
      window.requestIdleCallback(function() {
        walk(document.body);
        reveal();
      }, { timeout: 1500 });
    } else {
      setTimeout(function() {
        walk(document.body);
        reveal();
      }, 500);
    }
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  setTimeout(reveal, 3000);

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      mutation.addedNodes.forEach(function(node) {
        walk(node);
      });
    });
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

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
