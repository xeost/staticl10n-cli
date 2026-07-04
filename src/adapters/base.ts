import type { Page, Response } from 'playwright';
import type { ProjectConfig } from '../core/config.js';

// ─── Site Adapter Interface ───────────────────────────────────────────────────

export interface SiteAdapter {
  name: string;

  /** Returns true if the HTML / URL appears to belong to this site type. */
  detect(html: string, url: string): boolean;

  /**
   * Hook executed BEFORE capturing the HTML with page.content().
   * Use this for framework-specific waits (e.g. waiting for React hydration).
   */
  beforeCapture(page: Page, projectConfig: ProjectConfig): Promise<void>;

  /**
   * Optional hook that returns the raw HTML to persist for this page, called
   * AFTER beforeCapture(). When omitted, the exporter falls back to
   * `page.content()` (the live, potentially post-hydration DOM).
   *
   * Frameworks that hydrate a server-rendered tree (e.g. Next.js App Router)
   * embed a flight/RSC payload in the page that describes the pristine
   * server-rendered markup. `page.content()` returns the DOM *after* React
   * has committed changes during hydration (attribute/class mutations from
   * anti-FOUC scripts, etc.), which no longer matches that payload. Serving
   * this post-hydration snapshot as if it were fresh SSR output makes every
   * real visitor's hydration fail (React error #418) on load, since the
   * browser diffs the embedded payload against the (already mutated) DOM.
   * Returning the original network response body here avoids that mismatch.
   */
  getRawHtml?(page: Page, navigationResponse: Response | null): Promise<string>;

  /**
   * Post-processes the captured HTML string before saving to disk.
   * Operates on the HTML string only — does NOT receive a Playwright Page.
   */
  processHTML(html: string, pageUrl: string, projectConfig: ProjectConfig): Promise<string>;

  /** Returns additional asset URLs that this framework requires (e.g. fonts). */
  getAdditionalAssets(html: string, pageUrl: string): string[];

  /**
   * Rewrites asset paths in the HTML to local relative paths using the provided map.
   * pageUrl is the original URL of the page (used to resolve relative/root-relative hrefs).
   */
  rewriteAssetPaths(html: string, assetMap: Map<string, string>, pageUrl: string): string;

  /**
   * Returns true if this site type requires the runtime translation patch (translations.js).
   * True for sites with JS frameworks that control the DOM (Next.js).
   */
  needsRuntimePatch(): boolean;

  /**
   * Optional hook called once after all pages have been captured.
   * Use for output-directory–level post-processing (e.g. patching downloaded JS chunks).
   */
  postCapture?(outputDir: string): Promise<void>;
}
