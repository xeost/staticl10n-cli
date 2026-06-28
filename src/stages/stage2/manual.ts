import fs from 'fs-extra';
import path from 'path';
import * as cheerio from 'cheerio';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import type { ProjectConfig } from '../../core/config.js';
import { dbGetProjectBySlug, dbGetCachedTranslation } from '../../core/db.js';
import { hashFragment, storeCachedTranslation } from './cache.js';
import { verifyPlaceholderIntegrity } from './translator.js';
import { extractFragments } from './extractor.js';
import { applyPreTranslationInMemory } from '../stage1/personalizer.js';
import { translateProject } from './index.js';
import { extractMetaFragments } from './meta.js';
import { logger } from '../../utils/logger.js';
import type { HtmlFragment } from './extractor.js';

// ─── Manual Translation Stage Manager ──────────────────────────────────────────

export interface ManualOptions {
  pages: any[];
  languages: string[];
  actionName: string;
  targetPageUrl?: string;
}

/**
 * Prompt stage selector and execute Etapa 1, 2 or 3 of manual translation.
 */
export async function runManualTranslationStage(
  projectSlug: string,
  config: ProjectConfig,
  options: ManualOptions,
): Promise<void> {
  const project = dbGetProjectBySlug(projectSlug);
  if (!project) {
    logger.error(`Project "${projectSlug}" not found`);
    return;
  }

  while (true) {
    console.log();
    const { stage } = await inquirer.prompt([
      {
        type: 'list',
        name: 'stage',
        message: `Select manual translation stage to execute for ${options.actionName}:`,
        choices: [
          { name: '1. Generate manual translation files (Stage 1)', value: 1 },
          { name: '2. Import manual translations to cache (Stage 2)', value: 2 },
          { name: '3. Build translated website files (Stage 3)', value: 3 },
          { name: '← Back', value: 'back' },
        ],
      },
    ]);

    if (stage === 'back') return;

    if (stage === 1) {
      await runStage1Generate(project.id, projectSlug, config, options.pages, options.languages);
    } else if (stage === 2) {
      await runStage2Import(project.id, projectSlug, config, options.pages, options.languages);
    } else if (stage === 3) {
      await runStage3Build(projectSlug, config, options.pages, options.languages, options.targetPageUrl);
    }
  }
}

// ─── Etapa 1: Generate Files ───────────────────────────────────────────────────

async function runStage1Generate(
  projectId: number,
  projectSlug: string,
  config: ProjectConfig,
  pages: any[],
  languages: string[],
): Promise<void> {
  const spinner = ora('Generating manual translation files...').start();
  try {
    const translationDir = path.join(config.paths.tmp, 'translation');
    fs.ensureDirSync(translationDir);

    // Clean up old unified prompt.txt if it exists
    try {
      fs.unlinkSync(path.join(translationDir, 'prompt.txt'));
    } catch {}

    for (const lang of languages) {
      const langDir = path.join(translationDir, lang);
      const origDir = path.join(translationDir, `${lang}-original`);

      fs.ensureDirSync(langDir);
      fs.ensureDirSync(origDir);

      const exportedHashes = new Set<string>();

      for (const page of pages) {
        const originalHtmlPath = path.join(config.paths.original, page.path);
        if (!fs.existsSync(originalHtmlPath)) continue;

        const rawHtml = fs.readFileSync(originalHtmlPath, 'utf-8');
        const originalHtml = applyPreTranslationInMemory(rawHtml, config);
        const { fragments } = extractFragments(originalHtml, config.translation.maxFragmentTokens);
        const metaFragments = extractMetaFragments(originalHtml);
        const allFragments = [...fragments, ...metaFragments];

        // Only include fragments that do not exist in cache with model 'manual'
        // AND have not been exported to manual parts in this run yet
        const pendingFragments = allFragments.filter((f) => {
          const hash = hashFragment(f.outerHtml);
          const cached = dbGetCachedTranslation(projectId, hash, lang);
          const isAlreadyCached = cached && cached.model === 'manual';
          const isAlreadyExported = exportedHashes.has(hash);

          if (!isAlreadyCached && !isAlreadyExported) {
            exportedHashes.add(hash);
            return true;
          }
          return false;
        });

        if (pendingFragments.length > 0) {
          writeManualParts(page.id, lang, pendingFragments, config, langDir, origDir, projectId);
        }
      }

      // Generate prompt-${lang}.txt
      const promptPath = path.join(translationDir, `prompt-${lang}.txt`);
      const sourceLangUpper = config.translation.sourceLanguage.toUpperCase();
      const targetLangUpper = lang.toUpperCase();

      let promptContent = '';

      if (config.translation.context) {
        promptContent += `Project Context:\n${config.translation.context}\n\n`;
      }

      if (config.translation.preserveTerms && config.translation.preserveTerms.length > 0) {
        promptContent += `Preserve the following terms exactly as they are (do not translate them):\n`;
        for (const term of config.translation.preserveTerms) {
          promptContent += `- ${term}\n`;
        }
        promptContent += '\n';
      }

      promptContent += `Perform a literal translation of the texts in this file from ${sourceLangUpper} to ${targetLangUpper} using an informal but professional tone, don't run any script just translate the files: \n`;

      fs.writeFileSync(promptPath, promptContent, 'utf-8');
    }

    spinner.succeed('Manual translation files generated successfully.');
    logger.info(`Files generated under: ${chalk.cyan(translationDir)}`);
    logger.info('Please translate the files in the language folders, then select Stage 2.');
  } catch (err) {
    spinner.fail(`Failed to generate translation files: ${(err as Error).message}`);
  }
}

/**
 * Splits page fragments into yaml and html parts (limited to ~100 lines per part file).
 */
function writeManualParts(
  pageId: number,
  lang: string,
  fragments: HtmlFragment[],
  config: ProjectConfig,
  langDir: string,
  origDir: string,
  projectId: number,
): void {
  const pageLangDir = path.join(langDir, String(pageId));
  const pageOrigDir = path.join(origDir, String(pageId));
  fs.ensureDirSync(pageLangDir);
  fs.ensureDirSync(pageOrigDir);

  let htmlPartBuffer: HtmlFragment[] = [];
  let yamlPartBuffer: HtmlFragment[] = [];
  let htmlPartIndex = 1;
  let yamlPartIndex = 1;
  let htmlLinesCount = 0;
  let yamlLinesCount = 0;

  const countLines = (str: string) => str.split(/\r?\n/).length;

  const hasHtmlOrMultiline = (text: string) => {
    if (text.includes('\n') || text.includes('\r')) return true;
    return /<[a-zA-Z\/]/.test(text);
  };

  const flushHtml = () => {
    if (htmlPartBuffer.length === 0) return;
    const origLines: string[] = [];
    const transLines: string[] = [];

    for (const f of htmlPartBuffer) {
      origLines.push(`<div id="${f.id}">`, f.outerHtml, `</div>`, '');
      const hash = hashFragment(f.outerHtml);
      const cached = dbGetCachedTranslation(projectId, hash, lang);
      const transText = cached ? cached.translated_text : f.outerHtml;
      transLines.push(`<div id="${f.id}">`, transText, `</div>`, '');
    }

    const origFile = path.join(pageOrigDir, `part${htmlPartIndex}.html`);
    const transFile = path.join(pageLangDir, `part${htmlPartIndex}.html`);
    fs.writeFileSync(origFile, origLines.join('\n'), 'utf-8');
    fs.writeFileSync(transFile, transLines.join('\n'), 'utf-8');

    htmlPartIndex++;
    htmlPartBuffer = [];
    htmlLinesCount = 0;
  };

  const flushYaml = () => {
    if (yamlPartBuffer.length === 0) return;
    const origObj: Record<string, string> = {};
    const transObj: Record<string, string> = {};

    for (const f of yamlPartBuffer) {
      origObj[f.id] = f.outerHtml;
      const hash = hashFragment(f.outerHtml);
      const cached = dbGetCachedTranslation(projectId, hash, lang);
      transObj[f.id] = cached ? cached.translated_text : f.outerHtml;
    }

    const origFile = path.join(pageOrigDir, `part${yamlPartIndex}.yaml`);
    const transFile = path.join(pageLangDir, `part${yamlPartIndex}.yaml`);
    fs.writeFileSync(origFile, yamlDump(origObj), 'utf-8');
    fs.writeFileSync(transFile, yamlDump(transObj), 'utf-8');

    yamlPartIndex++;
    yamlPartBuffer = [];
    yamlLinesCount = 0;
  };

  for (const f of fragments) {
    if (hasHtmlOrMultiline(f.outerHtml)) {
      const addedLines = countLines(f.outerHtml) + 3; // +3 for div start, end, blank line
      if (htmlPartBuffer.length > 0 && htmlLinesCount + addedLines > 100) {
        flushHtml();
      }
      htmlPartBuffer.push(f);
      htmlLinesCount += addedLines;
    } else {
      if (yamlPartBuffer.length > 0 && yamlLinesCount + 1 > 100) {
        flushYaml();
      }
      yamlPartBuffer.push(f);
      yamlLinesCount += 1;
    }
  }

  flushHtml();
  flushYaml();
}

// ─── Etapa 2: Import & Validate ────────────────────────────────────────────────

async function runStage2Import(
  projectId: number,
  projectSlug: string,
  config: ProjectConfig,
  pages: any[],
  languages: string[],
): Promise<void> {
  const spinner = ora('Importing manual translations...').start();
  try {
    let totalErrorsCount = 0;
    const errorsList: string[] = [];

    for (const lang of languages) {
      const langDir = path.join(config.paths.tmp, 'translation', lang);
      const origDir = path.join(config.paths.tmp, 'translation', `${lang}-original`);

      if (!fs.existsSync(langDir) || !fs.existsSync(origDir)) {
        continue;
      }

      for (const page of pages) {
        const originalHtmlPath = path.join(config.paths.original, page.path);
        if (!fs.existsSync(originalHtmlPath)) continue;

        const rawHtml = fs.readFileSync(originalHtmlPath, 'utf-8');
        const originalHtml = applyPreTranslationInMemory(rawHtml, config);
        const { fragments } = extractFragments(originalHtml, config.translation.maxFragmentTokens);
        const metaFragments = extractMetaFragments(originalHtml);
        const allFragments = [...fragments, ...metaFragments];
        const fragmentLookup = new Map<string, HtmlFragment>();
        for (const f of allFragments) {
          fragmentLookup.set(f.id, f);
        }

        const pageLangDir = path.join(langDir, String(page.id));
        const pageOrigDir = path.join(origDir, String(page.id));

        if (!fs.existsSync(pageLangDir)) {
          if (fs.existsSync(pageOrigDir)) {
            try {
              fs.removeSync(pageOrigDir);
            } catch {}
          }
          continue;
        }

        const files = fs.existsSync(pageLangDir)
          ? fs.readdirSync(pageLangDir).filter(
              (f) => f.startsWith('part') && (f.endsWith('.html') || f.endsWith('.yaml'))
            )
          : [];

        if (files.length === 0) continue;

        const successfulImports: Array<{ sourceText: string; translatedText: string }> = [];
        const failedFragments: HtmlFragment[] = [];
        const fileErrors: string[] = [];

        for (const file of files) {
          const transPath = path.join(pageLangDir, file);
          const origPath = path.join(pageOrigDir, file);

          if (!fs.existsSync(origPath)) {
            fileErrors.push(`Original file ${file} is missing in ${lang}-original/${page.id}/`);
            continue;
          }

          if (file.endsWith('.html')) {
            const transHtml = fs.readFileSync(transPath, 'utf-8');
            const origHtml = fs.readFileSync(origPath, 'utf-8');

            const $trans = cheerio.load(transHtml);
            const $orig = cheerio.load(origHtml);

            $orig('div[id]').each((_i, el) => {
              const id = $orig(el).attr('id')!;
              const transDiv = $trans(`div[id="${id}"]`);
              if (transDiv.length === 0) {
                fileErrors.push(`[${file}] Missing block <div id="${id}">`);
                const lookupF = fragmentLookup.get(id);
                if (lookupF) failedFragments.push(lookupF);
                return;
              }

              const lookupF = fragmentLookup.get(id);
              if (!lookupF) return;

              const sourceText = lookupF.outerHtml;
              const translatedText = (transDiv.html() ?? '').trim();

              const validation = verifyPlaceholderIntegrity(translatedText, sourceText, lookupF.placeholders);
              if (validation.passed) {
                successfulImports.push({ sourceText, translatedText });
              } else {
                fileErrors.push(`[${file}] Block "${id}" integrity check failed: ${validation.reason}`);
                failedFragments.push(lookupF);
              }
            });
          } else if (file.endsWith('.yaml')) {
            try {
              const transObj = yamlLoad(fs.readFileSync(transPath, 'utf-8')) as Record<string, string> || {};
              const origObj = yamlLoad(fs.readFileSync(origPath, 'utf-8')) as Record<string, string> || {};

              for (const [id, _originalValue] of Object.entries(origObj)) {
                const lookupF = fragmentLookup.get(id);
                if (!lookupF) continue;

                const translatedValue = transObj[id];
                if (translatedValue === undefined) {
                  fileErrors.push(`[${file}] Missing YAML key "${id}"`);
                  failedFragments.push(lookupF);
                  continue;
                }

                const sourceText = lookupF.outerHtml;
                const translatedText = String(translatedValue).trim();

                const validation = verifyPlaceholderIntegrity(translatedText, sourceText, lookupF.placeholders);
                if (validation.passed) {
                  successfulImports.push({ sourceText, translatedText });
                } else {
                  fileErrors.push(`[${file}] YAML key "${id}" integrity check failed: ${validation.reason}`);
                  failedFragments.push(lookupF);
                }
              }
            } catch (yamlErr) {
              fileErrors.push(`[${file}] YAML parsing failed: ${(yamlErr as Error).message}`);
              const origObj = yamlLoad(fs.readFileSync(origPath, 'utf-8')) as Record<string, string> || {};
              for (const id of Object.keys(origObj)) {
                const lookupF = fragmentLookup.get(id);
                if (lookupF) failedFragments.push(lookupF);
              }
            }
          }
        }

        // Delete parsed part files
        for (const file of files) {
          try {
            fs.unlinkSync(path.join(pageLangDir, file));
            fs.unlinkSync(path.join(pageOrigDir, file));
          } catch {}
        }

        // Store successful translations under 'manual' model name
        for (const imp of successfulImports) {
          storeCachedTranslation(projectId, imp.sourceText, lang, imp.translatedText, 'manual');
        }

        if (failedFragments.length > 0) {
          totalErrorsCount += fileErrors.length;
          errorsList.push(...fileErrors.map((e) => `[${lang}] Page ${page.path}: ${e}`));

          // Regenerate parts containing ONLY failed fragments
          writeManualParts(page.id, lang, failedFragments, config, langDir, origDir, projectId);
        }

        // Clean up page folders if empty
        try {
          if (fs.existsSync(pageLangDir) && fs.readdirSync(pageLangDir).length === 0) {
            fs.rmdirSync(pageLangDir);
          }
          if (fs.existsSync(pageOrigDir) && fs.readdirSync(pageOrigDir).length === 0) {
            fs.rmdirSync(pageOrigDir);
          }
        } catch {}
      }

      // Cleanup folders if completely empty
      if (fs.existsSync(langDir) && fs.readdirSync(langDir).length === 0) {
        fs.rmdirSync(langDir);
      }
      if (fs.existsSync(origDir) && fs.readdirSync(origDir).length === 0) {
        fs.rmdirSync(origDir);
      }
    }

    if (totalErrorsCount > 0) {
      spinner.warn(`Import completed with ${totalErrorsCount} validation error(s).`);
      console.log(chalk.bold('\nValidation Errors:'));
      for (const err of errorsList) {
        console.log(`  ${chalk.red('✗')} ${err}`);
      }
      console.log();
      logger.info('Please resolve the errors in the rewritten files and run Stage 2 (Import) again.');
    } else {
      spinner.succeed('All manual translations imported and cached successfully.');
    }
  } catch (err) {
    spinner.fail(`Failed to import translations: ${(err as Error).message}`);
  }
}

// ─── Etapa 3: Build Pages ─────────────────────────────────────────────────────

async function runStage3Build(
  projectSlug: string,
  config: ProjectConfig,
  pages: any[],
  languages: string[],
  targetPageUrl?: string,
): Promise<void> {
  // Check if any part files remain for the selected pages/languages
  for (const lang of languages) {
    const langDir = path.join(config.paths.tmp, 'translation', lang);
    if (fs.existsSync(langDir)) {
      for (const page of pages) {
        const pageLangDir = path.join(langDir, String(page.id));
        if (fs.existsSync(pageLangDir)) {
          const files = fs.readdirSync(pageLangDir).filter(
            (f) => f.startsWith('part') && (f.endsWith('.html') || f.endsWith('.yaml'))
          );
          if (files.length > 0) {
            logger.error(
              `Cannot build translated files: page "${page.path}" has pending manual translations. Please translate and import them (Stage 2) first.`,
            );
            return;
          }
        }
      }
    }
  }

  const spinner = ora('Building translated pages from cache (manual mode)...').start();
  try {
    const result = await translateProject(
      projectSlug,
      config,
      languages,
      targetPageUrl,
      undefined,
      undefined,
      true, // isManualMode = true
    );
    spinner.stop();
    logger.success(`Build complete: ${result.pagesTranslated} page(s) compiled successfully from manual cache.`);
  } catch (err) {
    spinner.stop();
    logger.error(`Failed to compile pages: ${(err as Error).message}`);
  }
}
