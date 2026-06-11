import type { Page } from 'playwright';
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
