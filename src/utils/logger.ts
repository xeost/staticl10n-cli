import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_DIR = path.join(process.cwd(), 'data', 'logs');

// Current log file path, set on first log write
let currentLogFile: string | null = null;

function getLogFile(): string {
  if (!currentLogFile) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    currentLogFile = path.join(LOG_DIR, `staticl10n-${ts}.log`);
    fs.ensureDirSync(LOG_DIR);
  }
  return currentLogFile as string;
}

function writeToFile(level: LogLevel, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
    fs.appendFileSync(getLogFile(), line);
  } catch {
    // Silently ignore file write errors to avoid recursion
  }
}

function formatMessage(level: LogLevel, message: string): string {
  const ts = new Date().toLocaleTimeString();
  switch (level) {
    case 'debug':
      return chalk.gray(`[${ts}] DEBUG ${message}`);
    case 'info':
      return chalk.cyan(`[${ts}] INFO  ${message}`);
    case 'warn':
      return chalk.yellow(`[${ts}] WARN  ${message}`);
    case 'error':
      return chalk.red(`[${ts}] ERROR ${message}`);
  }
}

export const logger = {
  debug(message: string): void {
    if (process.env.DEBUG) {
      console.log(formatMessage('debug', message));
    }
    writeToFile('debug', message);
  },

  info(message: string): void {
    console.log(formatMessage('info', message));
    writeToFile('info', message);
  },

  warn(message: string): void {
    console.warn(formatMessage('warn', message));
    writeToFile('warn', message);
  },

  error(message: string): void {
    console.error(formatMessage('error', message));
    writeToFile('error', message);
  },

  success(message: string): void {
    console.log(chalk.green(`✓ ${message}`));
    writeToFile('info', `[SUCCESS] ${message}`);
  },

  /** Print a plain message without any prefix (used for titles/banners). */
  plain(message: string): void {
    console.log(message);
  },
};
