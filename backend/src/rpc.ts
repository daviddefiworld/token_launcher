import { createPublicClient, http } from 'viem';
import { BASE_CHAIN } from './skills/tokenlaunch/config';

const RPC_RETRY_ATTEMPTS = 5;
const RPC_RETRY_DELAY_MS = 800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBaseRpcUrl(): string {
  return process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';
}

export function createBasePublicClient() {
  return createPublicClient({ chain: BASE_CHAIN, transport: http(getBaseRpcUrl()) });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return `${error.message} ${causeText}`.toLowerCase();
}

function isRetryableRpcError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('429') ||
    text.includes('rate limit') ||
    text.includes('-32016') ||
    text.includes('fetch failed') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('socket hang up') ||
    text.includes('network')
  );
}

export async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === RPC_RETRY_ATTEMPTS) break;
      await sleep(RPC_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: ${String(lastError)}`);
}
