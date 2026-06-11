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

/**
 * Same as delayWithJitter, but resolves immediately if the provided AbortSignal is aborted.
 */
export function abortableDelayWithJitter(
  baseMs: number,
  jitterMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const total = baseMs + Math.floor(Math.random() * jitterMs);
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, total);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
