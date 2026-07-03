import { decodeEventLog, formatEther, getAddress, type Address } from 'viem';
import type { LaunchTradeStats, PoolTrade } from '../../types';

export type { LaunchTradeStats };
import { MIN_DETECTION_BUY_WEI } from './config';
import { ALL_DEX_ROUTERS, type DexAdapter } from './dex';

const LOG_CHUNK_BLOCKS = 2_000n;
const CHUNK_DELAY_MS = 400;

// Exclude every supported DEX router from buyer detection regardless of which pool we scan.
const PROTOCOL_ADDRESSES = new Set<string>(ALL_DEX_ROUTERS);

export function tradeKey(trade: PoolTrade): string {
  return `${trade.txHash}:${trade.logIndex}`;
}

export function mergeTrades(existing: PoolTrade[], incoming: PoolTrade[]): PoolTrade[] {
  const map = new Map<string, PoolTrade>();
  for (const trade of [...existing, ...incoming]) {
    map.set(tradeKey(trade), trade);
  }
  return [...map.values()].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex
  );
}

function isExternalTrader(trade: PoolTrade): boolean {
  return (
    !trade.isOwnWallet &&
    trade.side === 'buy' &&
    !PROTOCOL_ADDRESSES.has(trade.trader.toLowerCase())
  );
}

/** External buy whose ETH value meets the detection minimum (dust buys excluded). */
function isQualifyingBuyer(trade: PoolTrade): boolean {
  return isExternalTrader(trade) && BigInt(trade.ethAmount) >= MIN_DETECTION_BUY_WEI;
}

/** Unique external buyers seen, including sub-threshold dust buys (display/"seen" count). */
export function countExternalBuyersFromTrades(trades: PoolTrade[]): number {
  const buyers = new Set<string>();
  for (const trade of trades) {
    if (isExternalTrader(trade)) {
      buyers.add(trade.trader.toLowerCase());
    }
  }
  return buyers.size;
}

/** Unique external buyers meeting the detection minimum — drives LP-removal triggers. */
export function countQualifyingBuyersFromTrades(trades: PoolTrade[]): number {
  const buyers = new Set<string>();
  for (const trade of trades) {
    if (isQualifyingBuyer(trade)) {
      buyers.add(trade.trader.toLowerCase());
    }
  }
  return buyers.size;
}

export function computeTradeStats(trades: PoolTrade[]): LaunchTradeStats {
  const externalBuyers = new Set<string>();
  const qualifyingBuyers = new Set<string>();
  const externalSellers = new Set<string>();
  let buys = 0;
  let sells = 0;
  let ownWalletSwaps = 0;

  for (const trade of trades) {
    if (trade.side === 'buy') buys += 1;
    else sells += 1;
    if (trade.isOwnWallet) ownWalletSwaps += 1;
    else if (isExternalTrader(trade)) {
      externalBuyers.add(trade.trader.toLowerCase());
      if (isQualifyingBuyer(trade)) qualifyingBuyers.add(trade.trader.toLowerCase());
    } else if (
      trade.side === 'sell' &&
      !PROTOCOL_ADDRESSES.has(trade.trader.toLowerCase())
    ) {
      externalSellers.add(trade.trader.toLowerCase());
    }
  }

  return {
    totalSwaps: trades.length,
    buys,
    sells,
    externalBuyers: externalBuyers.size,
    qualifyingBuyers: qualifyingBuyers.size,
    externalSellers: externalSellers.size,
    ownWalletSwaps
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTrader(
  sender: Address,
  to: Address,
  side: PoolTrade['side'],
  ourWallets: Set<string>,
  protocolAddresses: Set<string> = PROTOCOL_ADDRESSES
): { trader: Address; isOwnWallet: boolean } {
  const senderLower = sender.toLowerCase();
  const toLower = to.toLowerCase();
  const senderIsProtocol = protocolAddresses.has(senderLower);
  const toIsProtocol = protocolAddresses.has(toLower);

  let trader: Address;
  if (side === 'buy') {
    // Router-mediated buys deliver tokens to `to`; ignore the router as sender.
    trader = !toIsProtocol ? getAddress(to) : !senderIsProtocol ? getAddress(sender) : getAddress(to);
  } else {
    trader = !senderIsProtocol ? getAddress(sender) : !toIsProtocol ? getAddress(to) : getAddress(sender);
  }

  return {
    trader,
    isOwnWallet: ourWallets.has(trader.toLowerCase())
  };
}

type RawSwapLog = {
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
  data: `0x${string}`;
  topics: [] | [`0x${string}`, ...`0x${string}`[]];
};

function decodeSwapLog(
  adapter: DexAdapter,
  log: RawSwapLog,
  tokenIs0: boolean,
  ourWallets: Set<string>,
  blockTimestamps: Map<number, string>
): PoolTrade | null {
  const decoded = decodeEventLog({
    abi: adapter.poolAbi,
    data: log.data,
    topics: log.topics
  });
  if (decoded.eventName !== 'Swap') return null;

  const { sender, to, amount0In, amount1In, amount0Out, amount1Out } = decoded.args as unknown as {
    sender: Address;
    to: Address;
    amount0In: bigint;
    amount1In: bigint;
    amount0Out: bigint;
    amount1Out: bigint;
  };

  const boughtToken = tokenIs0
    ? amount0Out > 0n && amount1In > 0n
    : amount1Out > 0n && amount0In > 0n;
  const soldToken = tokenIs0
    ? amount0In > 0n && amount1Out > 0n
    : amount1In > 0n && amount0Out > 0n;

  if (!boughtToken && !soldToken) return null;

  const side: PoolTrade['side'] = boughtToken ? 'buy' : 'sell';
  const tokenAmount = tokenIs0
    ? side === 'buy'
      ? amount0Out
      : amount0In
    : side === 'buy'
      ? amount1Out
      : amount1In;
  const ethAmount = tokenIs0
    ? side === 'buy'
      ? amount1In
      : amount1Out
    : side === 'buy'
      ? amount0In
      : amount0Out;

  const { trader, isOwnWallet } = resolveTrader(sender, to, side, ourWallets);
  const blockNumber = Number(log.blockNumber);

  return {
    logIndex: log.logIndex,
    txHash: log.transactionHash,
    blockNumber,
    timestamp: blockTimestamps.get(blockNumber) ?? '',
    side,
    trader,
    tokenAmount: tokenAmount.toString(),
    ethAmount: ethAmount.toString(),
    ethAmountFormatted: formatEther(ethAmount),
    tokenAmountFormatted: formatEther(tokenAmount),
    isOwnWallet,
    belowDetectionThreshold: ethAmount < MIN_DETECTION_BUY_WEI
  };
}

type PublicClientLike = {
  readContract: (args: unknown) => Promise<unknown>;
  getLogs: (args: unknown) => Promise<unknown[]>;
  getBlockNumber: () => Promise<bigint>;
  getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }>;
  getTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ blockNumber: bigint } | null>;
};

export async function fetchPoolTrades(
  client: PublicClientLike,
  adapter: DexAdapter,
  poolAddress: Address,
  tokenAddress: Address,
  fromBlock: bigint,
  ourWallets: Set<string>,
  onChunk?: (trades: PoolTrade[]) => void
): Promise<PoolTrade[]> {
  const token0 = (await client.readContract({
    address: poolAddress,
    abi: adapter.poolAbi,
    functionName: 'token0'
  })) as Address;
  const tokenIs0 = getAddress(token0) === getAddress(tokenAddress);

  const latest = await client.getBlockNumber();
  const start = fromBlock > latest ? latest : fromBlock;
  const allLogs: RawSwapLog[] = [];

  for (let chunkStart = start; chunkStart <= latest; chunkStart += LOG_CHUNK_BLOCKS + 1n) {
    const chunkEnd =
      chunkStart + LOG_CHUNK_BLOCKS > latest ? latest : chunkStart + LOG_CHUNK_BLOCKS;
    const logs = (await client.getLogs({
      address: poolAddress,
      event: adapter.swapEvent,
      fromBlock: chunkStart,
      toBlock: chunkEnd
    })) as RawSwapLog[];
    allLogs.push(...logs);
    if (chunkEnd < latest) await sleep(CHUNK_DELAY_MS);
  }

  const blockNumbers = [...new Set(allLogs.map((log) => Number(log.blockNumber)))];
  const blockTimestamps = new Map<number, string>();
  for (const blockNumber of blockNumbers) {
    const block = await client.getBlock({ blockNumber: BigInt(blockNumber) });
    blockTimestamps.set(blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
  }

  const trades: PoolTrade[] = [];
  for (const log of allLogs) {
    const trade = decodeSwapLog(adapter, log, tokenIs0, ourWallets, blockTimestamps);
    if (trade) trades.push(trade);
  }

  trades.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (onChunk) onChunk(trades);
  return trades;
}

export async function resolveFromBlock(
  client: PublicClientLike,
  deployTxHash: `0x${string}` | undefined,
  deployBlockNumber: number | undefined,
  sinceMs: number
): Promise<bigint> {
  if (deployBlockNumber !== undefined && deployBlockNumber >= 0) {
    return BigInt(deployBlockNumber);
  }
  if (deployTxHash) {
    const receipt = await client.getTransactionReceipt({ hash: deployTxHash });
    if (receipt?.blockNumber !== undefined) return receipt.blockNumber;
  }
  return blockNearTimestamp(client, sinceMs);
}

async function blockNearTimestamp(client: PublicClientLike, timestampMs: number): Promise<bigint> {
  const latest = await client.getBlockNumber();
  const latestBlock = await client.getBlock({ blockNumber: latest });
  const latestTs = Number(latestBlock.timestamp) * 1000;
  if (timestampMs >= latestTs) return latest;

  const secondsAgo = Math.max(0, Math.floor((latestTs - timestampMs) / 1000));
  const estimatedBlocks = BigInt(Math.min(Number(latest), Math.max(1, Math.ceil(secondsAgo / 2))));
  return latest > estimatedBlocks ? latest - estimatedBlocks : 0n;
}
