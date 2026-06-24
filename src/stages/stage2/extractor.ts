import * as cheerio from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';

// ─── HTML Fragment Extractor ──────────────────────────────────────────────────

export interface PlaceholderEntry {
  /** Original tag name, e.g. 'a' or 'span' */
  name: string;
  /** Original attributes map */
  attribs: Record<string, string>;
  /** Closing tag, e.g. '</a>'. Empty string for void elements. */
  close: string;
  /** Optional original inner HTML (for atomic inline elements like svg) */
  innerHTML?: string;
}

export interface HtmlFragment {
  id: string;
  /**
   * For attribute fragments: the original attribute value sent to the LLM.
   * For block fragments: placeholder-mapped text sent to the LLM
   *   (e.g. "Start your <1>journey</1> today").
   */
  outerHtml: string;
  isAttribute: boolean;
  attributeName?: string;
  /** CSS-like selector to locate the element for attribute fragments. */
  elementSelector?: string;
  /**
   * For block fragments: maps each placeholder number to its original HTML
   * open/close tags. Used to reconstruct the translated HTML after LLM response.
   */
  placeholders?: Map<number, PlaceholderEntry>;
}

// Block-level tags that are candidates for extraction
const BLOCK_TAGS = new Set([
  'section', 'article', 'div', 'p', 'li', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'figcaption',
  'header', 'footer', 'main', 'aside', 'nav', 'figure',
  'a', 'small', 'button', 'span', 'caption', 'dt', 'dd', 'dl', 'label',
  'summary', 'legend', 'option',
]);

// Tags whose full content should be excluded from translation extraction
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link', 'pre', 'code']);

// Leaf-content tags that are always extracted if they have significant text,
// bypassing the text-ratio check (which fails when class/href attributes inflate markup length)
const ALWAYS_EXTRACT_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'caption', 'dt', 'label',
  'a', 'small', 'button', 'span', 'summary', 'legend', 'option',
]);

// Inline elements that are replaced with numbered placeholder tags when building
// the text sent to the LLM, e.g. <span class="bold"> → <1>
const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdo', 'big', 'button', 'cite', 'code', 'del',
  'dfn', 'em', 'i', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small',
  'span', 'strong', 'sub', 'sup', 'time', 'u', 'var',
]);

// Void inline elements that produce self-closing placeholders: <N/>
const VOID_INLINE_TAGS = new Set(['br', 'wbr', 'img', 'input', 'embed', 'area', 'col']);

// Atomic inline elements (e.g. svg, picture) that are replaced with placeholders,
// but their children are preserved wholesale without translation.
const ATOMIC_INLINE_TAGS = new Set(['svg', 'picture', 'canvas', 'iframe']);

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

      if (!hasBlockDescendants(el) && (ALWAYS_EXTRACT_TAGS.has(tag) || textRatio > 0.6 || hasDirectSignificantText(el)) && hasSignificantText(getTextContent($, el))) {
        // Build placeholder-mapped text and check token budget against it
        const { text: placeholderText, placeholders } = buildPlaceholderText($, el);
        const tokenCount = Math.ceil(placeholderText.length / 4);

        if (tokenCount <= maxFragmentTokens) {
          const id = `f${++counter}`;
          $(el).attr('data-sl-id', id);
          fragments.push({ id, outerHtml: placeholderText, isAttribute: false, placeholders });
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

// ─── Placeholder Builder ─────────────────────────────────────────────────────

/**
 * Walks the children of a block element and produces placeholder-mapped text.
 * Inline elements are replaced by numbered markers (e.g. <1>text</1>) and
 * the original open/close tags are stored in the returned placeholders map.
 */
function buildPlaceholderText(
  $: cheerio.CheerioAPI,
  blockEl: Element,
): { text: string; placeholders: Map<number, PlaceholderEntry> } {
  let counter = 0;
  const placeholders = new Map<number, PlaceholderEntry>();

  function processNode(node: AnyNode): string {
    if (node.type === 'text') {
      const rawText = (node as Text).data ?? '';
      return rawText.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    if (node.type !== 'tag') return '';
    const el = node as Element;
    const tag = el.tagName?.toLowerCase() ?? '';
    if (SKIP_TAGS.has(tag)) return '';

    if (VOID_INLINE_TAGS.has(tag)) {
      const n = ++counter;
      placeholders.set(n, { name: tag, attribs: { ...el.attribs }, close: '' });
      return `<span id="${n}"></span>`;
    }

    if (ATOMIC_INLINE_TAGS.has(tag)) {
      const n = ++counter;
      const innerHtml = $.html((el.children ?? []) as any);
      placeholders.set(n, {
        name: tag,
        attribs: { ...el.attribs },
        close: `</${tag}>`,
        innerHTML: innerHtml,
      });
      return `<span id="${n}"></span>`;
    }

    if (INLINE_TAGS.has(tag)) {
      const n = ++counter;
      placeholders.set(n, {
        name: tag,
        attribs: { ...el.attribs },
        close: `</${tag}>`,
      });
      const inner = ((el.children ?? []) as AnyNode[]).map(processNode).join('');
      return `<span id="${n}">${inner}</span>`;
    }

    // Nested block / unknown tag: recurse without wrapping
    return ((el.children ?? []) as AnyNode[]).map(processNode).join('');
  }

  const text = ((blockEl.children ?? []) as AnyNode[]).map(processNode).join('').trim();
  return { text, placeholders };
}

/** Serialises an element's attributes to a string suitable for a tag, skipping data-sl-id. */
function buildAttribString(attribs: Record<string, string> | undefined): string {
  if (!attribs) return '';
  const pairs = Object.entries(attribs)
    .filter(([k]) => k !== 'data-sl-id')
    .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
    .join(' ');
  return pairs ? ` ${pairs}` : '';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true if the element contains any descendant tags that are considered
 * block-level elements (i.e. not inline tags and not void inline tags).
 * This ensures we do not collapse parent blocks (like divs containing headers/paragraphs)
 * into a single flat fragment, preserving the original DOM structural formatting.
 */
function hasBlockDescendants(el: Element): boolean {
  let hasBlock = false;

  function check(node: AnyNode) {
    if (hasBlock) return;
    if (node.type === 'tag') {
      const tag = (node as Element).tagName?.toLowerCase();
      if (tag) {
        if (ATOMIC_INLINE_TAGS.has(tag)) {
          // Atomic inline element: its children are preserved wholesale without translation
          return;
        }
        if (!INLINE_TAGS.has(tag) && !VOID_INLINE_TAGS.has(tag)) {
          hasBlock = true;
          return;
        }
      }
      ((node as Element).children as AnyNode[])?.forEach(check);
    }
  }

  (el.children as AnyNode[])?.forEach(check);
  return hasBlock;
}

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
