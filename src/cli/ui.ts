import chalk from 'chalk';

// ─── Terminal UI Helpers ──────────────────────────────────────────────────────

/**
 * Clears the visible terminal viewport and moves the cursor to the top-left.
 * Previous content is pushed to the scrollback buffer — it remains accessible
 * by scrolling up in the terminal.
 */
export function clearScreen(): void {
  process.stdout.write('\x1B[2J\x1B[H');
}

/**
 * Prints the full ASCII art banner. Used at the main menu.
 */
export function printBanner(): void {
  console.log(
    chalk.cyan.bold(`
  ╔═══════════════════════════════════════╗
  ║         staticl10n  v0.1.0           ║
  ║   Static Localization CLI Tool       ║
  ╚═══════════════════════════════════════╝
`),
  );
}

/**
 * Prints a compact breadcrumb header for stage sub-menus.
 * Example:  staticl10n  ›  My Project  ›  Stage 1: Capture
 */
export function printStageHeader(stage: string, projectName?: string): void {
  const parts: string[] = [chalk.cyan.bold('staticl10n')];
  if (projectName) parts.push(chalk.green(projectName));
  parts.push(chalk.white(stage));
  console.log('\n  ' + parts.join(chalk.gray('  ›  ')) + '\n');
}
