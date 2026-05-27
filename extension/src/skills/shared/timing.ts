export const POLL_INTERVAL_MS = 500;

export function stepDelay(): Promise<void> {
  const ms = 1000 + Math.floor(Math.random() * 2000);
  return delay(ms);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function waitFor<T>(
  factory: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs: number = POLL_INTERVAL_MS
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = factory();
    if (value) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error('Timed out waiting for page state');
}
