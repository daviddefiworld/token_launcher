import type { Abi, AbiEvent, Address } from 'viem';
import type { DexKey } from '../../types';
import {
  AERODROME,
  UNISWAP,
  aerodromeFactoryAbi,
  aerodromePoolAbi,
  aerodromeRouterAbi,
  uniswapFactoryAbi,
  uniswapPoolAbi,
  uniswapRouterAbi
} from './config';

export type { DexKey };

interface LiquidityArgs {
  token: Address;
  tokenAmount: bigint;
  amountTokenMin: bigint;
  amountEthMin: bigint;
  to: Address;
  deadline: bigint;
}

interface RemoveLiquidityArgs {
  token: Address;
  liquidity: bigint;
  amountTokenMin: bigint;
  amountEthMin: bigint;
  to: Address;
  deadline: bigint;
}

interface SwapArgs {
  amountOutMin: bigint;
  token: Address;
  to: Address;
  deadline: bigint;
}

/**
 * Uniform interface over the constant-product DEXes on Base. Aerodrome (a Solidly
 * fork) and Uniswap V2 share function names but differ in router args (Aerodrome's
 * `stable` flag and `Route[]` vs V2's flat `address[] path`), factory lookup
 * (`getPool` vs `getPair`), creation event (`PoolCreated` vs `PairCreated`), the
 * pair `Swap` event arg order, and LP-fee claiming (Aerodrome only).
 */
export interface DexAdapter {
  key: DexKey;
  label: string;
  router: Address;
  factory: Address;
  weth: Address;
  routerAbi: Abi;
  factoryAbi: Abi;
  poolAbi: Abi;
  /** Swap event ABI entry — used as the getLogs filter and decode source. */
  swapEvent: AbiEvent;
  /** Factory read fn returning the pool/pair address for a token pair. */
  getPoolFunctionName: 'getPool' | 'getPair';
  /** Router fn used to buy tokens with ETH (fee-on-transfer-safe variant on Uniswap V2). */
  swapFunctionName: string;
  /** Fee-on-transfer-safe LP removal fn, used as a fallback when the plain remove reverts. */
  removeLiquiditySupportingFunctionName: string;
  /** Factory event emitted on pool/pair creation. */
  poolCreatedEventName: 'PoolCreated' | 'PairCreated';
  /** Aerodrome pools accrue claimable LP fees; Uniswap V2 pairs do not. */
  supportsClaimFees: boolean;
  getPoolArgs(tokenA: Address, tokenB: Address): readonly unknown[];
  addLiquidityEthArgs(args: LiquidityArgs): readonly unknown[];
  removeLiquidityEthArgs(args: RemoveLiquidityArgs): readonly unknown[];
  swapExactEthForTokensArgs(args: SwapArgs): readonly unknown[];
  /** Normalize a decoded PoolCreated/PairCreated event into common fields. */
  parseCreatedPool(args: Record<string, unknown>): { pool: Address; token0: Address; token1: Address };
}

const AERODROME_ADAPTER: DexAdapter = {
  key: 'aerodrome',
  label: 'Aerodrome',
  router: AERODROME.router,
  factory: AERODROME.factory,
  weth: AERODROME.weth,
  routerAbi: aerodromeRouterAbi as unknown as Abi,
  factoryAbi: aerodromeFactoryAbi as unknown as Abi,
  poolAbi: aerodromePoolAbi as unknown as Abi,
  swapEvent: aerodromePoolAbi[0] as unknown as AbiEvent,
  getPoolFunctionName: 'getPool',
  poolCreatedEventName: 'PoolCreated',
  swapFunctionName: 'swapExactETHForTokens',
  removeLiquiditySupportingFunctionName: 'removeLiquidityETHSupportingFeeOnTransferTokens',
  supportsClaimFees: true,
  getPoolArgs: (tokenA, tokenB) => [tokenA, tokenB, false],
  addLiquidityEthArgs: ({ token, tokenAmount, amountTokenMin, amountEthMin, to, deadline }) => [
    token,
    false,
    tokenAmount,
    amountTokenMin,
    amountEthMin,
    to,
    deadline
  ],
  removeLiquidityEthArgs: ({ token, liquidity, amountTokenMin, amountEthMin, to, deadline }) => [
    token,
    false,
    liquidity,
    amountTokenMin,
    amountEthMin,
    to,
    deadline
  ],
  swapExactEthForTokensArgs: ({ amountOutMin, token, to, deadline }) => [
    amountOutMin,
    [{ from: AERODROME.weth, to: token, stable: false, factory: AERODROME.factory }],
    to,
    deadline
  ],
  parseCreatedPool: (args) => ({
    pool: args.pool as Address,
    token0: args.token0 as Address,
    token1: args.token1 as Address
  })
};

const UNISWAP_ADAPTER: DexAdapter = {
  key: 'uniswap',
  label: 'Uniswap V2',
  router: UNISWAP.router,
  factory: UNISWAP.factory,
  weth: UNISWAP.weth,
  routerAbi: uniswapRouterAbi as unknown as Abi,
  factoryAbi: uniswapFactoryAbi as unknown as Abi,
  poolAbi: uniswapPoolAbi as unknown as Abi,
  swapEvent: uniswapPoolAbi[0] as unknown as AbiEvent,
  getPoolFunctionName: 'getPair',
  poolCreatedEventName: 'PairCreated',
  swapFunctionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
  removeLiquiditySupportingFunctionName: 'removeLiquidityETHSupportingFeeOnTransferTokens',
  supportsClaimFees: false,
  getPoolArgs: (tokenA, tokenB) => [tokenA, tokenB],
  addLiquidityEthArgs: ({ token, tokenAmount, amountTokenMin, amountEthMin, to, deadline }) => [
    token,
    tokenAmount,
    amountTokenMin,
    amountEthMin,
    to,
    deadline
  ],
  removeLiquidityEthArgs: ({ token, liquidity, amountTokenMin, amountEthMin, to, deadline }) => [
    token,
    liquidity,
    amountTokenMin,
    amountEthMin,
    to,
    deadline
  ],
  swapExactEthForTokensArgs: ({ amountOutMin, token, to, deadline }) => [
    amountOutMin,
    [UNISWAP.weth, token],
    to,
    deadline
  ],
  parseCreatedPool: (args) => ({
    pool: args.pair as Address,
    token0: args.token0 as Address,
    token1: args.token1 as Address
  })
};

export const DEX_ADAPTERS: readonly DexAdapter[] = [UNISWAP_ADAPTER, AERODROME_ADAPTER];

/** Default DEX for NEW launches (applied by the input parser when `dex` is omitted). */
export const DEFAULT_DEX: DexKey = 'uniswap';

/**
 * Resolve an adapter for a stored job. Legacy jobs created before the `dex` field
 * existed have no `dex` and were launched on Aerodrome, so an absent value MUST map
 * to Aerodrome here — this is a back-compat fallback, NOT the new-launch default
 * (see DEFAULT_DEX for that).
 */
export function getDexAdapter(dex?: DexKey): DexAdapter {
  return dex === 'uniswap' ? UNISWAP_ADAPTER : AERODROME_ADAPTER;
}

/** Router addresses of every supported DEX — used to exclude routers from buyer detection. */
export const ALL_DEX_ROUTERS: readonly string[] = DEX_ADAPTERS.map((adapter) =>
  adapter.router.toLowerCase()
);
