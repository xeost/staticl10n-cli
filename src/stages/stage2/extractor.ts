import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

// ─── HTML Fragment Extractor ──────────────────────────────────────────────────

export interface HtmlFragment {
  id: string;
  outerHtml: string;
  isAttribute: boolean;
  attributeName?: string;
  /** CSS-like selector to locate the element for attribute fragments */
  elementSelector?: string;
}

// Block-level tags that are candidates for extraction
const BLOCK_TAGS = new Set([
  'section', 'article', 'div', 'p', 'li', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption',
  'header', 'footer', 'main', 'aside', 'nav', 'figure',
]);

// Tags whose full content should be excluded from translation extraction
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link', 'code', 'pre']);

// Translatable attribute names
const TRANSLATABLE_ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'];

/**
 * Extracts translatable HTML fragments from a page using a greedy-upward strategy.
 * Also extracts translatable attributes (alt, title, placeholder, aria-*).
 */
export function extractFragments(html: string): HtmlFragment[] {
  const $ = cheerio.load(html);
  const fragments: HtmlFragment[] = [];
  const extractedNodes = new WeakSet<AnyNode>();
  let counter = 0;

  function isExtracted(node: AnyNode): boolean {
    let current: AnyNode | null = node;
    while (current) {
      if (extractedNodes.has(current)) return true;
      current = (current as Element).parent ?? null;
    }
    return false;
  }

  // Walk the DOM top-down looking for extractable block elements
  function walk(node: AnyNode): void {
    if (node.type !== 'tag') return;
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    if (!tag || SKIP_TAGS.has(tag)) return;

    // Skip JSON-LD scripts (handled separately)
    if (tag === 'script' && el.attribs?.type === 'application/ld+json') return;

    // Skip already-extracted ancestors
    if (isExtracted(node)) return;

    if (BLOCK_TAGS.has(tag)) {
      const outer = $.html(el);
      const textRatio = computeTextRatio(outer);

      if (textRatio > 0.6 && hasSignificantText(getTextContent($, el))) {
        // Assign a unique data-sl-id
        const id = `f${++counter}`;
        $(el).attr('data-sl-id', id);
        const finalOuter = $.html(el);

        // Check token budget; split if necessary
        const tokenCount = Math.ceil(finalOuter.length / 4);
        const budget = 2000; // default maxFragmentTokens

        if (tokenCount <= budget) {
          fragments.push({ id, outerHtml: finalOuter, isAttribute: false });
          extractedNodes.add(node);
          return; // Do not descend further
        }
        // Fragment is too large — descend into children instead
      }
    }

    // Recurse into children
    (el.children as AnyNode[])?.forEach(walk);
  }

  // Start walking from body
  const body = $('body').get(0);
  if (body) walk(body);

  // Extract translatable attributes
  $('*').each((_i: number, el: AnyNode) => {
    if (el.type !== 'tag') return;
    const element = el as Element;
    for (const attr of TRANSLATABLE_ATTRS) {
      const val = element.attribs?.[attr];
      if (val && hasSignificantText(val)) {
        const id = `a${++counter}`;
        fragments.push({
          id,
          outerHtml: val,
          isAttribute: true,
          attributeName: attr,
          elementSelector: buildSelector(element),
        });
      }
    }
  });

  return fragments;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns plain text content of an element. */
function getTextContent($: cheerio.CheerioAPI, el: Element): string {
  return $(el).text().trim();
}

/** Returns true if the string has significant translatable content. */
function hasSignificantText(text: string): boolean {
  if (!text || text.trim().length < 2) return false;
  // Reject strings that are only numbers/symbols/whitespace
  return /[a-zA-ZÀ-ÿ\u4e00-\u9fa5\u3040-\u30ff]/.test(text);
}

/** Computes the ratio of text content to total markup length. */
function computeTextRatio(html: string): number {
  const textLength = html.replace(/<[^>]+>/g, '').trim().length;
  return textLength / Math.max(html.length, 1);
}

/** Builds a simple CSS selector path for an element to locate it for attribute rewriting. */
function buildSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.type === 'tag') {
    let selector = current.tagName.toLowerCase();
    if (current.attribs?.id) {
      selector += `#${current.attribs.id}`;
      parts.unshift(selector);
      break;
    }
    parts.unshift(selector);
    current = (current.parent as Element | null);
  }
  return parts.join(' > ');
}
