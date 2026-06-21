import fs from 'fs-extra';
import path from 'path';

// ─── Sitemap Generator ────────────────────────────────────────────────────────

/**
 * Generates a sitemap.xml in the given output directory for one language.
 *
 * Each entry maps: sourceBaseUrl + pagePathname → targetBaseUrl + pagePathname
 * e.g. "http://localhost:9001/docs/intro" → "https://es.example.com/docs/intro"
 *
 * If targetBaseUrl is empty, falls back to sourceBaseUrl.
 */
export function generateSitemap(
  outputDir: string,
  sourceBaseUrl: string,
  targetBaseUrl: string,
  pageUrls: string[],
): void {
  const base = (targetBaseUrl || sourceBaseUrl).replace(/\/$/, '');

  const locs = pageUrls
    .map((rawUrl) => {
      try {
        const pathname = new URL(rawUrl).pathname;
        return escapeXml(`${base}${pathname}`);
      } catch {
        return null;
      }
    })
    .filter((loc): loc is string => loc !== null)
    .sort();

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locs.map((loc) => `  <url>\n    <loc>${loc}</loc>\n  </url>`),
    '</urlset>',
    '',
  ].join('\n');

  fs.ensureDirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, 'sitemap.xml'), xml, 'utf-8');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
