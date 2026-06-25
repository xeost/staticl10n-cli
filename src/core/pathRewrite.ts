import type { PathRewriteRule } from './config.js';

// ─── Path Rewrite Utility ─────────────────────────────────────────────────────

/**
 * Applies an ordered list of regex rewrite rules to a URL pathname.
 * Returns the pathname unchanged if no rules are configured.
 *
 * @example
 * rewritePath('/en/getting-started/', [{ pattern: '^/en/', replacement: '/' }])
 * // → '/getting-started/'
 */
export function rewritePath(pathname: string, rules: PathRewriteRule[] | undefined): string {
  if (!rules?.length) return pathname;
  let result = pathname;
  const hasLeadingSlash = result.startsWith('/');
  if (!hasLeadingSlash) {
    result = '/' + result;
  }
  for (const rule of rules) {
    result = result.replace(new RegExp(rule.pattern), rule.replacement);
  }
  if (!hasLeadingSlash && result.startsWith('/')) {
    result = result.slice(1);
  }
  return result;
}
