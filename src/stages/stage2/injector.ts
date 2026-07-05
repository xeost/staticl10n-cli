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
          if (entry.innerHTML !== undefined) {
            $(el).html(entry.innerHTML);
          }
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
      // Reconstruct full HTML (restoring img/svg/etc. from placeholders) before
      // storing in the runtime patch dictionary. Without this, the MutationObserver
      // would set innerHTML to placeholder text like "<1/>" which the browser
      // renders as an empty unknown element, making images disappear.
      let inner: string;
      if (fragment.placeholders && fragment.placeholders.size > 0) {
        inner = reconstructFromPlaceholders(translated, fragment.placeholders);
      } else {
        const $t = cheerio.load(translated);
        const firstChild = $t('body').children().first();
        inner = (firstChild.length > 0 ? firstChild.html() : $t('body').html()) ?? translated;
      }
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

  // Returns false if the element contains interactive children (buttons, inputs, etc.).
  // Setting innerHTML on such elements creates new DOM nodes disconnected from React's
  // fiber tree, which breaks event handlers like the theme toggle button.
  function isSafeToReplace(el) {
    return !el.querySelector('button, input, select, textarea, [role="button"], [tabindex]');
  }

  function walk(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    var tag = node.tagName && node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
    if (node.hasAttribute('data-sl-id')) {
      var id = node.getAttribute('data-sl-id');
      if (F[id] !== undefined && isSafeToReplace(node)) node.innerHTML = F[id];
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
      if (e.el.isConnected && isSafeToReplace(e.el)) e.el.innerHTML = F[e.id];
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
    // IMPORTANT: do NOT call walk() here. walk() mutates the DOM (innerHTML/attributes)
    // synchronously, and init() runs as soon as this deferred script executes — which
    // can be before or during React's hydration pass. Mutating the DOM at that point
    // races with hydration and triggers a hard hydration mismatch (React error #418),
    // causing React to discard the whole subtree via a full client-side re-render
    // (reverting to the original, untranslated JSX and wiping other DOM attributes).
    // walk() is only safe to call from the MutationObserver below, for nodes added
    // after hydration has already completed (e.g. client-side navigations).
    // Cache element references NOW, before React hydration removes data-sl-id attributes.
    document.querySelectorAll('[data-sl-id]').forEach(function(el) {
      var id = el.getAttribute('data-sl-id');
      if (id && F[id] !== undefined) entries.push({ el: el, id: id });
    });

    // Wait for React hydration to finish, then re-apply and reveal.
    // IMPORTANT: applyAll() calls observer.observe() for the first time here, NOT at
    // the top level. The observer must NOT run during React hydration — doing so would
    // trigger applyAll() mid-hydration (setting innerHTML while React reconciles),
    // which corrupts the fiber tree and breaks all event handlers (theme toggle, etc.).
    //
    // requestIdleCallback is NOT a reliable "hydration finished" signal: it fires as
    // soon as the main thread is idle for a moment, which can happen WHILE React is
    // still waiting on async chunks (e.g. Suspense boundaries / lazy client components)
    // — i.e. well before hydration has actually completed. Applying translations at
    // that point still races with hydration and reproduces the same #418 mismatch.
    // Instead, detect quiescence: watch document.body for mutations (hydration causes
    // a burst of DOM activity while it attaches listeners / commits lazy chunks) and
    // only run afterHydration() once no mutation has been observed for SETTLE_MS.
    // A maximum wait caps how long a pathological page can stay hidden.
    var SETTLE_MS = 300;
    var MAX_WAIT_MS = 4000;
    var settled = false;
    var settleTimer = null;

    function afterHydration() {
      if (settled) return;
      settled = true;
      preHydrationObserver.disconnect();
      applyAll();
      reveal();
    }

    function scheduleSettleCheck() {
      if (settled) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(afterHydration, SETTLE_MS);
    }

    var preHydrationObserver = new MutationObserver(scheduleSettleCheck);
    preHydrationObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    scheduleSettleCheck();
    setTimeout(afterHydration, MAX_WAIT_MS);
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }

  // Absolute safety net: reveal even if the settle-detection above never fires.
  setTimeout(reveal, 6000);

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

  // NOTE: observer.observe() is NOT called here. It is first started inside
  // afterHydration() → applyAll() after React's hydration is complete.

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
