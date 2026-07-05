import * as cheerio from 'cheerio';
import type { HtmlFragment, PlaceholderEntry } from './extractor.js';
import type { ProjectConfig } from '../../core/config.js';
import { META_SELECTORS } from './meta.js';



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
  translatedHtml?: string,
  config?: ProjectConfig,
  lang?: string,
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
      // Reconstruct HTML from placeholders
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

  // Extract translated title and SEO meta tag values from the translated HTML
  const metaDict: Record<string, string> = {};
  if (translatedHtml) {
    const $ = cheerio.load(translatedHtml);
    const titleText = $('head > title').text().trim();
    if (titleText) {
      metaDict['title'] = titleText;
    }
    for (const item of META_SELECTORS) {
      const el = $(item.selector);
      if (el.length) {
        const val = el.attr(item.attrName);
        if (val) {
          metaDict[item.selector] = val.trim();
        }
      }
    }
  }

  // Collect active personalization rules for this language/page
  const activeRules: any[] = [];
  if (config && config.personalization) {
    const preRules = config.personalization.preTranslation || [];
    const postRules = config.personalization.postTranslation || [];

    for (const rule of preRules) {
      activeRules.push(rule);
    }

    for (const rule of postRules) {
      if (lang && rule.languages && !rule.languages.includes(lang)) {
        continue;
      }
      activeRules.push(rule);
    }
  }

  const timestamp = new Date().toISOString();

  return `// Archivo: translations.js — generado automáticamente por staticl10n
// NO editar manualmente. Generado el: ${timestamp}
(function() {
  'use strict';

  var F = ${JSON.stringify(fragmentDict)};

  var A = ${JSON.stringify(attributeDict)};

  var R = ${JSON.stringify(activeRules)};

  var M = ${JSON.stringify(metaDict)};

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

  function applyRule(rule) {
    try {
      if (rule.type === 'remove_element') {
        if (rule.selector) {
          document.querySelectorAll(rule.selector).forEach(function(el) {
            el.remove();
          });
        }
      } else if (rule.type === 'remove_attribute') {
        if (rule.selector && rule.attribute) {
          document.querySelectorAll(rule.selector).forEach(function(el) {
            el.removeAttribute(rule.attribute);
          });
        }
      } else if (rule.type === 'replace_text') {
        if (rule.search && rule.replace !== undefined) {
          if (rule.selector) {
            if (rule.selector === 'title' || rule.selector.indexOf('title') !== -1) {
              if (rule.replace && document.title.indexOf(rule.replace) !== -1) {
                // Already replaced
              } else if (document.title.indexOf(rule.search) !== -1) {
                document.title = document.title.split(rule.search).join(rule.replace);
              }
            }
            document.querySelectorAll(rule.selector).forEach(function(el) {
              var current = el.innerHTML || '';
              if (rule.replace && current.indexOf(rule.replace) !== -1) {
                return;
              }
              var updated = current.split(rule.search).join(rule.replace);
              if (updated !== current) {
                el.innerHTML = updated;
              }
            });
          } else {
            var current = document.body.innerHTML || '';
            if (rule.replace && current.indexOf(rule.replace) !== -1) {
              return;
            }
            var updated = current.split(rule.search).join(rule.replace);
            if (updated !== current) {
              document.body.innerHTML = updated;
            }
          }
        }
      } else if (rule.type === 'inject_html') {
        if (rule.html) {
          var pos = rule.position || 'body_end';
          if (pos === 'head_end') {
            var temp = document.createElement('div');
            temp.innerHTML = rule.html;
            while (temp.firstChild) {
              document.head.appendChild(temp.firstChild);
            }
          } else if (pos === 'body_start') {
            var temp = document.createElement('div');
            temp.innerHTML = rule.html;
            while (temp.lastChild) {
              document.body.insertBefore(temp.lastChild, document.body.firstChild);
            }
          } else if (pos === 'body_end') {
            var temp = document.createElement('div');
            temp.innerHTML = rule.html;
            while (temp.firstChild) {
              document.body.appendChild(temp.firstChild);
            }
          } else if (pos.indexOf('after_selector:') === 0) {
            var sel = pos.substring('after_selector:'.length);
            document.querySelectorAll(sel).forEach(function(targetEl) {
              var temp = document.createElement('div');
              temp.innerHTML = rule.html;
              while (temp.firstChild) {
                targetEl.parentNode.insertBefore(temp.firstChild, targetEl.nextSibling);
              }
            });
          }
        }
      } else if (rule.type === 'add_attribute') {
        if (rule.selector && rule.attribute && rule.replace !== undefined) {
          document.querySelectorAll(rule.selector).forEach(function(el) {
            el.setAttribute(rule.attribute, rule.replace);
          });
        }
      }
    } catch (e) {
      console.error('[staticl10n] Error applying personalization rule:', rule, e);
    }
  }

  function applyAllRules() {
    R.forEach(applyRule);
  }

  function applyMeta() {
    if (M.title) {
      if (document.title !== M.title) {
        document.title = M.title;
      }
      var titleEl = document.querySelector('head > title');
      if (titleEl && titleEl.innerHTML !== M.title) {
        titleEl.innerHTML = M.title;
      }
    }
    Object.keys(M).forEach(function(selector) {
      if (selector === 'title') return;
      var el = document.querySelector(selector);
      if (el && el.getAttribute('content') !== M[selector]) {
        el.setAttribute('content', M[selector]);
      }
    });
  }

  // Re-applies all cached translations using stored element references.
  // Disconnects the observer first to prevent infinite mutation loops.
  function applyAll() {
    observer.disconnect();
    entries.forEach(function(e) {
      if (e.el.isConnected && isSafeToReplace(e.el)) e.el.innerHTML = F[e.id];
    });
    document.querySelectorAll('[alt],[title],[placeholder],[aria-label],[aria-description]').forEach(translateAttributes);
    applyMeta();
    applyAllRules();
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    document.body.style.opacity = '1';
    var hideEl = document.getElementById('staticl10n-hide');
    if (hideEl) hideEl.remove();
  }

  function init() {
    document.querySelectorAll('[data-sl-id]').forEach(function(el) {
      var id = el.getAttribute('data-sl-id');
      if (id && F[id] !== undefined) entries.push({ el: el, id: id });
    });

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

    var preHydrationObserver = new MutationObserver(function(mutations) {
      preHydrationObserver.disconnect();
      // Run remove_element rules immediately on newly added elements to prevent analytics loading
      R.forEach(function(rule) {
        if (rule.type === 'remove_element' && rule.selector) {
          document.querySelectorAll(rule.selector).forEach(function(el) {
            el.remove();
          });
        }
      });
      preHydrationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      scheduleSettleCheck();
    });
    preHydrationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
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
      if (!needsUpdate) {
        var tag = t.tagName && t.tagName.toLowerCase();
        if (tag === 'title' || tag === 'head' || t.parentNode === document.head) {
          needsUpdate = true;
        }
      }
    }
    if (needsUpdate) {
      applyAll();
    } else {
      observer.disconnect();
      for (var i = 0; i < mutations.length; i++) {
        mutations[i].addedNodes.forEach(function(n) {
          if (n.nodeType === Node.ELEMENT_NODE) walk(n);
        });
      }
      applyAllRules();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
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
