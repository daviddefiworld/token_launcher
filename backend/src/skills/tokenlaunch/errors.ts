import { BaseError, ContractFunctionRevertedError, type Address } from 'viem';

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Router-level errors that mean "a token transfer inside this call reverted" without saying why.
 * Uniswap's TransferHelper/pair swallow the token's own revert data and re-throw a generic string,
 * so seeing one of these tells us to go probe the token directly for the real reason.
 */
const MASKED_TRANSFER_REVERTS = ['UniswapV2: TRANSFER_FAILED', 'TransferHelper: TRANSFER_FAILED'];

export function isMaskedTransferRevert(text: string): boolean {
  return MASKED_TRANSFER_REVERTS.some((masked) => text.includes(masked));
}

/**
 * The on-chain revert reason buried in a viem error chain: either the `require` string
 * ("UniswapV2: TRANSFER_FAILED", "Exceeds the _maxTxAmount.") or a custom error name.
 */
function revertReason(error: BaseError): string | undefined {
  const reverted = error.walk((err) => err instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  return reverted.reason?.trim() || reverted.data?.errorName?.trim() || undefined;
}

/**
 * Human-readable failure reason for a viem/RPC error.
 *
 * Raw `error.message` on a viem error is a multi-line wall of ABI/request context with the
 * actual cause buried in it, so pull out the parts that identify the failure: viem's
 * one-line `shortMessage`, the decoded revert reason, and the node's `details` string
 * (where RPC-level rejections like "insufficient funds for gas * price + value" live).
 */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const parts: string[] = [];
    // viem wraps the revert reason onto its own line inside shortMessage — flatten so the whole
    // description stays a single line the dashboard can render as-is.
    const short = oneLine(error.shortMessage || error.message.split('\n')[0]);
    if (short) parts.push(short);

    const reason = revertReason(error);
    if (reason && !parts.some((part) => part.includes(reason))) parts.push(`reverted: ${reason}`);

    const details = oneLine(error.details ?? '');
    if (details && !parts.some((part) => part.includes(details))) parts.push(details);

    return parts.join(' · ');
  }

  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : cause ? String(cause) : '';
    return causeText ? `${error.message} (${causeText})` : error.message;
  }

  return String(error);
}

const probeAbi = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  }
] as const;

/**
 * Recover the token's OWN revert reason behind a router's generic "TRANSFER_FAILED".
 *
 * When an LP removal reverts, the failing step is the pair->router token transfer performed inside
 * `burn()`. Uniswap discards that revert's data and reports "UniswapV2: TRANSFER_FAILED", which
 * says nothing about the cause. Re-running that exact transfer as a standalone `eth_call` (from the
 * pair, to the router) surfaces the real `require` string — e.g. "_transfer:: Trading is not
 * active." or "Max wallet exceeded" — which is what actually tells you what to fix.
 *
 * Best-effort: returns undefined if the probe passes (so the transfer wasn't the blocker) or if the
 * probe itself can't run.
 */
export async function probeTokenTransferRevert(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  publicClient: any,
  token: Address,
  from: Address,
  to: Address,
  amount: bigint
): Promise<string | undefined> {
  try {
    await publicClient.simulateContract({
      account: from,
      address: token,
      abi: probeAbi,
      functionName: 'transfer',
      args: [to, amount]
    });
    return undefined; // transfer is fine — the revert came from somewhere else
  } catch (error) {
    if (!(error instanceof BaseError)) return undefined;
    const reason = revertReason(error);
    // A masked reason here would just be the same unhelpful string — don't report it as the cause.
    return reason && !isMaskedTransferRevert(reason) ? reason : undefined;
  }
}
