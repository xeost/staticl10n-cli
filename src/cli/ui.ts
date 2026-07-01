import readline from 'readline';
import boxen from 'boxen';
import chalk from 'chalk';

// ─── Brand palette ───────────────────────────────────────────────────────────

export const C = {
  primary: chalk.hex('#A78BFA'),      // violet
  accent: chalk.hex('#34D399'),       // emerald
  warn: chalk.hex('#FBBF24'),         // amber
  danger: chalk.hex('#F87171'),       // rose
  muted: chalk.hex('#6B7280'),        // gray
  bold: chalk.bold,
  dim: chalk.dim,
  white: chalk.white,
  cyan: chalk.cyan,
  magenta: chalk.magenta,
};

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
 * Prints the styled boxen banner. Used at the main menu.
 */
export function printBanner(): void {
  const heading = chalk.hex('#C4B5FD').bold('Static Localization Assistant');
  const rule    = chalk.hex('#6D28D9')('━'.repeat(32));
  const url     = chalk.hex('#34D399')('staticl10n-cli');
  const tag     = chalk.hex('#6B7280')('  ·  Professional Tools');

  const content = `${heading}\n${rule}\n${url}${tag}`;

  console.log(
    boxen(content, {
      padding: { top: 1, bottom: 1, left: 4, right: 4 },
      borderStyle: 'double',
      borderColor: '#7C3AED',
      title: chalk.hex('#A78BFA').bold(' STATICL10N ') + chalk.hex('#34D399').bold('CLI '),
      titleAlignment: 'center',
      dimBorder: false,
    })
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

export interface MenuOption<T = string> {
  name: string;
  value: T;
}

export function promptSelect<T = string>(
  title: string,
  options: MenuOption<T>[],
  projectName?: string,
  lastValue?: T
): Promise<T | 'clear'> {
  // Render static parts once at the beginning
  printBanner();
  printStageHeader(title, projectName);

  // Hide the blinking terminal cursor during interaction
  process.stdout.write('\x1b[?25l');

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    let selectedIdx = lastValue !== undefined
      ? Math.max(0, options.findIndex((item) => item.value === lastValue))
      : 0;

    // Save cursor position right before choices are printed
    process.stdout.write('\x1b7');
    renderSubMenu(options, selectedIdx);

    function renderSubMenu(
      options: MenuOption<T>[],
      selectedIdx: number
    ): void {
      for (let i = 0; i < options.length; i++) {
        const item = options[i];
        const selected = i === selectedIdx;
        const marker = selected ? C.accent('❯ ') : '  ';

        // Determine numeric shortcut key
        const isBackOrExit = i === options.length - 1 && (
          String(item.value).includes('back') ||
          String(item.value).includes('exit') ||
          item.name.toLowerCase().includes('back') ||
          item.name.toLowerCase().includes('exit')
        );
        const key = isBackOrExit ? '0' : String(i + 1);

        const keyStr = isBackOrExit ? C.danger.bold(key + '.') : C.white.bold(key + '.');
        const labelStr = isBackOrExit
          ? C.danger(item.name)
          : selected ? C.white.bold(item.name) : C.white(item.name);

        console.log(`${marker}${keyStr} ${labelStr}`);
      }

      const keyChars = options.map((item, i) => {
        const isBackOrExit = i === options.length - 1 && (
          String(item.value).includes('back') ||
          String(item.value).includes('exit') ||
          item.name.toLowerCase().includes('back') ||
          item.name.toLowerCase().includes('exit')
        );
        return isBackOrExit ? '0' : String(i + 1);
      });
      const digitKeys = keyChars.map(k => parseInt(k, 10)).filter(k => !isNaN(k));
      const maxDigitKey = Math.max(...digitKeys);

      console.log();
      console.log(C.muted(`  ↑↓ navigate  ·  enter select  ·  0–${maxDigitKey} shortcut  ·  ⌫ clear screen`));
    }

    function redraw() {
      // Restore cursor & clear screen below
      process.stdout.write('\x1b8\x1b[J');
      renderSubMenu(options, selectedIdx);
    }

    function cleanup() {
      // Restore cursor visibility
      process.stdout.write('\x1b[?25h');
      process.stdin.off('data', onData);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    const onData = (data: Buffer) => {
      // Arrow keys (ESC [ A = up, ESC [ B = down)
      if (data.length === 3 && data[0] === 0x1b && data[1] === 0x5b) {
        if (data[2] === 0x41) {
          selectedIdx = (selectedIdx - 1 + options.length) % options.length;
          redraw();
        } else if (data[2] === 0x42) {
          selectedIdx = (selectedIdx + 1) % options.length;
          redraw();
        }
        return;
      }

      // Enter key
      if (data[0] === 0x0d || data[0] === 0x0a) {
        cleanup();
        clearScreen();
        resolve(options[selectedIdx].value);
        return;
      }

      // Backspace / Del
      if (data[0] === 0x7f || data[0] === 0x08) {
        cleanup();
        resolve('clear');
        return;
      }

      // Ctrl+C
      if (data[0] === 0x03) {
        cleanup();
        process.stdout.write('\n');
        process.kill(process.pid, 'SIGINT');
      }

      // Digit shortcut
      const keyChar = String.fromCharCode(data[0]);
      const keyChars = options.map((item, i) => {
        const isBackOrExit = i === options.length - 1 && (
          String(item.value).includes('back') ||
          String(item.value).includes('exit') ||
          item.name.toLowerCase().includes('back') ||
          item.name.toLowerCase().includes('exit')
        );
        return isBackOrExit ? '0' : String(i + 1);
      });

      if (keyChars.includes(keyChar)) {
        const idx = keyChars.indexOf(keyChar);
        if (idx !== -1) {
          selectedIdx = idx;
          redraw();
          setTimeout(() => {
            cleanup();
            clearScreen();
            resolve(options[selectedIdx].value);
          }, 120);
        }
        return;
      }
    };

    process.stdin.on('data', onData);
  });
}
