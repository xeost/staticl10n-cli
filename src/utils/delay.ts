/**
 * Waits for the specified number of milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for baseMs + a random amount between 0 and jitterMs.
 * Used between web requests to avoid detection and rate-limiting.
 */
export function delayWithJitter(baseMs: number, jitterMs: number): Promise<void> {
  const total = baseMs + Math.floor(Math.random() * jitterMs);
  return delay(total);
}
