/**
 * Read-only verification of the LP-removal fix against the live chain. Broadcasts nothing.
 *
 *   npx ts-node --transpile-only scripts/verify-remove-fix.ts
 */
import { createPublicClient, erc20Abi, http } from 'viem';
import { BASE_CHAIN, UNISWAP, uniswapRouterAbi } from '../src/skills/tokenlaunch/config';
import { feeTokenAbi } from '../src/skills/tokenlaunch/contracts';
import { describeError, probeTokenTransferRevert } from '../src/skills/tokenlaunch/errors';

const TOKEN = '0x4abd9d3989f1f8855ac18bc8ded51b97cb353180' as const;
const PAIR = '0x4520195CaD5ECc3dBfE338de58c5335c9A94917E' as const;
const W1 = '0xd6ee70204546b133ee9283628cbea1dfd437cc76' as const;

// `bool limitsEnabled` — slot 9 in Mystery's layout. Used only to prove the post-fix state works.
const LIMITS_OFF = [
  {
    address: TOKEN,
    stateDiff: [
      {
        slot: '0x0000000000000000000000000000000000000000000000000000000000000009' as const,
        value: '0x0000000000000000000000000000000000000000000000000000000000000000' as const
      }
    ]
  }
];

async function main() {
  const client = createPublicClient({ chain: BASE_CHAIN, transport: http() });

  const [limitsEnabled] = (await client.readContract({
    address: TOKEN,
    abi: feeTokenAbi,
    functionName: 'readLimitsInfo'
  })) as [boolean, bigint, bigint];
  const owner = await client.readContract({ address: TOKEN, abi: feeTokenAbi, functionName: 'owner' });
  const lpBalance = (await client.readContract({
    address: PAIR,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [W1]
  })) as bigint;
  const pairTokens = (await client.readContract({
    address: TOKEN,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [PAIR]
  })) as bigint;

  console.log('token state:', { limitsEnabled, owner, wallet1IsOwner: owner.toLowerCase() === W1, lpBalance, pairTokens });

  // 1. The unmasking probe: what does the router's "TRANSFER_FAILED" actually mean?
  const probed = await probeTokenTransferRevert(client, TOKEN, PAIR, UNISWAP.router, pairTokens);
  console.log('\n[1] pair->router transfer probe:', probed ?? '(no revert)');

  // 2. removeLimitsNow() — the fix. Simulate only.
  try {
    await client.simulateContract({ account: W1, address: TOKEN, abi: feeTokenAbi, functionName: 'removeLimitsNow' });
    console.log('[2] removeLimitsNow() from wallet 1: WOULD SUCCEED');
  } catch (error) {
    console.log('[2] removeLimitsNow() from wallet 1: FAILS —', describeError(error));
  }

  const removeArgs = [TOKEN, lpBalance, 0n, 0n, W1, BigInt(Math.floor(Date.now() / 1000) + 1200)] as const;
  const removeReq = {
    account: W1,
    address: UNISWAP.router,
    abi: uniswapRouterAbi,
    functionName: 'removeLiquidityETHSupportingFeeOnTransferTokens',
    args: removeArgs
  } as const;

  // 3. Removal against CURRENT state (limits on) — expected to revert.
  try {
    await client.simulateContract(removeReq);
    console.log('[3] removal @ current state: WOULD SUCCEED');
  } catch (error) {
    console.log('[3] removal @ current state (limits ON): reverts —', describeError(error));
  }

  // 4. Removal after limits are cleared — expected to succeed.
  try {
    const { result } = await client.simulateContract({ ...removeReq, stateOverride: LIMITS_OFF });
    console.log('[4] removal @ limitsEnabled=false: WOULD SUCCEED, returns', result, 'wei ETH');
  } catch (error) {
    console.log('[4] removal @ limitsEnabled=false: reverts —', describeError(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
