import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';

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
  'a', 'small', 'button', 'span',
]);

// Tags whose full content should be excluded from translation extraction
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link', 'pre', 'code']);

// Leaf-content tags that are always extracted if they have significant text,
// bypassing the text-ratio check (which fails when class/href attributes inflate markup length)
const ALWAYS_EXTRACT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'caption', 'dt', 'label',
  'a', 'small', 'button', 'span',
]);

// Translatable attribute names
const TRANSLATABLE_ATTRS = ['alt', 'title', 'placeholder', 'aria-label', 'aria-description'];

/**
 * Extracts translatable HTML fragments from a page using a greedy-upward strategy.
 * Also extracts translatable attributes (alt, title, placeholder, aria-*).
 * Returns the modified HTML (with data-sl-id attributes injected) and the fragments array.
 */
export function extractFragments(
  html: string,
  maxFragmentTokens = 2000,
): { html: string; fragments: HtmlFragment[] } {
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

      if ((ALWAYS_EXTRACT_TAGS.has(tag) || textRatio > 0.6 || hasDirectSignificantText(el)) && hasSignificantText(getTextContent($, el))) {
        // Assign a unique data-sl-id
        const id = `f${++counter}`;
        $(el).attr('data-sl-id', id);
        const finalOuter = $.html(el);

        // Check token budget; split if necessary
        const tokenCount = Math.ceil(finalOuter.length / 4);

        if (tokenCount <= maxFragmentTokens) {
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

  return { html: $.html(), fragments };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the element has at least one direct text-node child with
 * significant translatable text. This catches elements like
 * `<li>Code licensed <a>MIT</a>, docs <a>CC BY 3.0</a>.</li>` where the
 * surrounding text nodes can't be captured any other way.
 */
function hasDirectSignificantText(el: Element): boolean {
  return (el.children as AnyNode[])?.some((child) => {
    if (child.type !== 'text') return false;
    return hasSignificantText((child as Text).data ?? '');
  }) ?? false;
}

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

/** Computes the ratio of text content to total markup length.
 * Attribute values (href, class, src, etc.) are stripped from the denominator
 * so long URLs and class strings don't deflate the ratio for text-rich elements.
 */
function computeTextRatio(html: string): number {
  const textLength = html.replace(/<[^>]+>/g, '').trim().length;
  const normalizedHtml = html.replace(/="[^"]*"/g, '=""');
  return textLength / Math.max(normalizedHtml.length, 1);
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
