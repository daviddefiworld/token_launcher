import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type TransactionReceipt,
  type WalletClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type {
  AddLiquidityInput,
  AddLiquidityResult,
  DeployedTokenRecord,
  LpPosition,
  ManualLpRecord,
  ManualTokenDeployInput,
  RemoveLiquidityInput,
  TokenDeployType,
  TokenLaunchInput,
  TokenLaunchJob,
  LpRemovalResult,
  UnremovedLpPosition,
  TokenLaunchTradesBackfillResult,
  TokenLaunchTradesResponse
} from '../../types';
import {
  computeTradeStats,
  countExternalBuyersFromTrades,
  fetchPoolTrades,
  mergeTrades,
  resolveFromBlock
} from './swaps';
import { ManualDeployRepository, ManualLpRepository, TokenLaunchRepository, nowIso } from '../../persist';
import { describeError, probeTokenTransferRevert } from './errors';
import {
  BASE_CHAIN,
  DEFAULT_BUY_ETH,
  DEFAULT_LP_ETH,
  DEFAULT_MIN_BUYERS_BEFORE_REMOVE_LP,
  DEFAULT_REMOVE_LP_TIME_MINUTES,
  MAX_MIN_BUYERS_BEFORE_REMOVE_LP,
  MAX_REMOVE_LP_TIME_MINUTES,
  DEFAULT_BUY_AFTER_SECONDS,
  MAX_BUY_AFTER_SECONDS,
  SWAP_POLL_MS,
  wethAbi
} from './config';
import { DEFAULT_DEX, DEX_ADAPTERS, getDexAdapter, type DexAdapter, type DexKey } from './dex';
import { feeTokenAbi, feeTokenBytecode, launchTokenAbi, launchTokenBytecode } from './contracts';

export type TokenLaunchBroadcast = (job: TokenLaunchJob, event: 'created' | 'updated') => void;

const MAX_REPEAT_COUNT = 50;
const REPEAT_DELAY_MS = 3_000;
const LP_SCAN_DELAY_MS = 800;
// Cap how long we wait on a removal-path receipt so a stuck/dropped tx surfaces an error
// instead of hanging the request indefinitely.
const REMOVE_RECEIPT_TIMEOUT_MS = 90_000;
const TRADES_BACKFILL_JOB_DELAY_MS = 1_200;
const TRADES_BACKFILL_START_DELAY_MS = 8_000;

function resolveRemoveLpTimeMinutes(input: TokenLaunchInput): number {
  return input.removeLpTimeMinutes ?? DEFAULT_REMOVE_LP_TIME_MINUTES;
}

function removeLpMonitorMs(input: TokenLaunchInput): number {
  return resolveRemoveLpTimeMinutes(input) * 60 * 1000;
}

function formatRemoveLpTime(minutes: number): string {
  return minutes === 1 ? '1 min' : `${minutes} min`;
}

function resolveMinBuyersBeforeRemoveLp(input: TokenLaunchInput): number {
  return input.minBuyersBeforeRemoveLp ?? DEFAULT_MIN_BUYERS_BEFORE_REMOVE_LP;
}

function resolveWallet2BuyEthAmount(input: TokenLaunchInput): string {
  return input.wallet2BuyEthAmount?.trim() || input.buyEthAmount;
}

function resolveUseWallet3(input: TokenLaunchInput): boolean {
  return input.useWallet3 === true;
}

function resolveBuyAfterMs(input: TokenLaunchInput): number {
  const seconds = input.buyAfterSeconds ?? DEFAULT_BUY_AFTER_SECONDS;
  return seconds * 1000;
}
const MAX_UINT256 = 2n ** 256n - 1n;
const RPC_RETRY_ATTEMPTS = 5;
// First-time addLiquidity deploys a brand-new pair/pool via CREATE2 (~2.5-3M gas). The
// fallback floor (used when gas estimation fails) must comfortably cover that, otherwise a
// failed estimate drops to a too-low limit and the tx reverts out-of-gas mid pair-creation.
const ADD_LIQUIDITY_GAS_FLOOR = 4_000_000n;
// Estimation can transiently revert right after the approve receipt (the estimating node may
// not see the fresh allowance yet); retry a few times before falling back to the floor.
const GAS_ESTIMATE_ATTEMPTS = 3;
const GAS_ESTIMATE_RETRY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatViemError(error: unknown): string {
  if (error instanceof Error) {
    const nested = (error as Error & { cause?: unknown }).cause;
    const cause = nested instanceof Error ? nested.message : nested ? String(nested) : '';
    return cause ? `${error.message} (${cause})` : error.message;
  }
  return String(error);
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return prefixed as `0x${string}`;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 60 * 20);
}

const GAS_BUFFER_NUM = 12n;
const GAS_BUFFER_DEN = 10n;

function gasWithBuffer(estimate: bigint, floor: bigint): bigint {
  const buffered = (estimate * GAS_BUFFER_NUM) / GAS_BUFFER_DEN;
  return buffered > floor ? buffered : floor;
}

function isRateLimitError(error: unknown): boolean {
  const message = formatViemError(error).toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('-32016');
}

// Number of times to re-sync the nonce from chain and resend after a nonce mismatch.
const NONCE_RETRY_ATTEMPTS = 6;
const NONCE_RETRY_MS = 400;

// A nonce-too-low/high collision is recoverable by re-reading getTransactionCount and resending;
// the public Base RPC is multi-node and can report a stale (already-used) pending nonce right
// after a receipt resolves on a different node. Includes the neighbouring mempool errors that a
// stale or duplicate nonce can surface as.
function isNonceError(error: unknown): boolean {
  const message = formatViemError(error).toLowerCase();
  return (
    message.includes('nonce too low') ||
    message.includes('nonce too high') ||
    message.includes('next nonce') ||
    message.includes('invalid nonce') ||
    message.includes('already known') ||
    message.includes('replacement transaction underpriced')
  );
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRateLimitError(error) || attempt === RPC_RETRY_ATTEMPTS) break;
      await sleep(LP_SCAN_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: ${String(lastError)}`);
}

function receiptFailureMessage(label: string, receipt: TransactionReceipt, txHash: `0x${string}`): string {
  const lowGasRevert = receipt.status === 'reverted' && receipt.gasUsed < 50_000n;
  const hint = lowGasRevert ? ' (likely out of gas)' : '';
  return `${label}${hint} · tx ${txHash}`;
}

interface PoolCandidateMeta {
  tokenAddress?: Address;
  jobIds: string[];
  tokenName?: string;
  tokenSymbol?: string;
  dex: DexKey;
}

export class TokenLaunchService {
  private readonly running = new Set<string>();
  // Serializes outbound transactions per sending account so concurrent callers (e.g. an active
  // launch and an on-demand LP removal both using wallet 1) can't grab the same nonce.
  private readonly nonceQueue = new Map<Address, Promise<unknown>>();
  // Monotonic next-nonce per account. Guards against the load-balanced Base RPC returning a stale,
  // already-used pending nonce immediately after a receipt resolves on another node.
  private readonly nonceCursor = new Map<Address, number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publicClient: any = null;
  private wallet1: WalletClient | null = null;
  private wallet2: WalletClient | null = null;
  private wallet3: WalletClient | null = null;
  private wallet1Account: ReturnType<typeof privateKeyToAccount> | null = null;
  private wallet2Account: ReturnType<typeof privateKeyToAccount> | null = null;
  private wallet3Account: ReturnType<typeof privateKeyToAccount> | null = null;
  private wallet1Address: Address | null = null;
  private wallet2Address: Address | null = null;
  private wallet3Address: Address | null = null;
  private repeatInput: TokenLaunchInput | null = null;
  private repeatRemaining = 0;
  private readonly manualBuyInFlight = new Set<string>();
  private readonly cancelled = new Set<string>();
  private tradesBackfillRunning = false;
  private sessionWalletKeys: {
    wallet1: `0x${string}`;
    wallet2: `0x${string}`;
    wallet3?: `0x${string}`;
  } | null = null;

  constructor(
    private readonly repository: TokenLaunchRepository,
    private readonly broadcast?: TokenLaunchBroadcast,
    private readonly lpRepository: ManualLpRepository = new ManualLpRepository(),
    private readonly deployRepository: ManualDeployRepository = new ManualDeployRepository()
  ) {
    setTimeout(() => {
      void this.backfillAllTrades({ onlyMissing: true }).catch((error) => {
        console.error('Token launch trades backfill failed:', formatViemError(error));
      });
    }, TRADES_BACKFILL_START_DELAY_MS);
  }

  isConfigured(): boolean {
    const keys = this.resolveWalletKeys();
    return Boolean(keys.wallet1 && keys.wallet2 && (process.env.BASE_RPC_URL?.trim() || true));
  }

  hasActiveLaunch(): boolean {
    return Boolean(this.repository.findActive()) || this.repeatRemaining > 0 || this.running.size > 0;
  }

  useSessionWallets(keys: { wallet1: string; wallet2: string; wallet3?: string }): void {
    this.sessionWalletKeys = {
      wallet1: normalizePrivateKey(keys.wallet1),
      wallet2: normalizePrivateKey(keys.wallet2),
      wallet3: keys.wallet3 ? normalizePrivateKey(keys.wallet3) : undefined
    };
    this.resetClients();
  }

  clearSessionWallets(): void {
    this.sessionWalletKeys = null;
    this.resetClients();
  }

  private resolveWalletKeys(): { wallet1?: string; wallet2?: string; wallet3?: string } {
    if (this.sessionWalletKeys) {
      return {
        wallet1: this.sessionWalletKeys.wallet1,
        wallet2: this.sessionWalletKeys.wallet2,
        wallet3: this.sessionWalletKeys.wallet3
      };
    }
    return {
      wallet1: process.env.WALLET_1_PRIVATE_KEY?.trim(),
      wallet2: process.env.WALLET_2_PRIVATE_KEY?.trim(),
      wallet3: process.env.WALLET_3_PRIVATE_KEY?.trim()
    };
  }

  private resetClients(): void {
    this.publicClient = null;
    this.wallet1 = null;
    this.wallet2 = null;
    this.wallet3 = null;
    this.wallet1Account = null;
    this.wallet2Account = null;
    this.wallet3Account = null;
    this.wallet1Address = null;
    this.wallet2Address = null;
    this.wallet3Address = null;
  }

  async getStatus(): Promise<{
    configured: boolean;
    wallet1Address?: string;
    wallet2Address?: string;
    wallet3Address?: string;
    wallet1BalanceEth?: string;
    wallet2BalanceEth?: string;
    wallet3BalanceEth?: string;
    wallet3Configured: boolean;
    rpcUrl: string;
  }> {
    const rpcUrl = process.env.BASE_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com';
    const keys = this.resolveWalletKeys();
    if (!keys.wallet1 || !keys.wallet2) {
      return { configured: false, wallet3Configured: Boolean(keys.wallet3), rpcUrl };
    }

    try {
      this.ensureClients();
    } catch {
      return { configured: false, wallet3Configured: Boolean(keys.wallet3), rpcUrl };
    }

    const balances = await this.fetchWalletBalances();

    return {
      configured: true,
      wallet1Address: this.wallet1Address ?? undefined,
      wallet2Address: this.wallet2Address ?? undefined,
      wallet3Address: this.wallet3Address ?? undefined,
      wallet1BalanceEth: balances.wallet1,
      wallet2BalanceEth: balances.wallet2,
      wallet3BalanceEth: balances.wallet3,
      wallet3Configured: Boolean(keys.wallet3),
      rpcUrl
    };
  }

  private formatEthBalance(wei: bigint): string {
    return (Number(wei) / 1e18).toFixed(6);
  }

  private async fetchWalletBalances(): Promise<{
    wallet1?: string;
    wallet2?: string;
    wallet3?: string;
  }> {
    const client = this.publicClient;
    if (!client || !this.wallet1Address || !this.wallet2Address) return {};

    const [wallet1Wei, wallet2Wei, wallet3Wei] = await Promise.all([
      client.getBalance({ address: this.wallet1Address }),
      client.getBalance({ address: this.wallet2Address }),
      this.wallet3Address ? client.getBalance({ address: this.wallet3Address }) : Promise.resolve(null)
    ]);

    return {
      wallet1: this.formatEthBalance(wallet1Wei),
      wallet2: this.formatEthBalance(wallet2Wei),
      wallet3: wallet3Wei !== null ? this.formatEthBalance(wallet3Wei) : undefined
    };
  }

  private jobUsesWallet3(input: TokenLaunchInput): boolean {
    return resolveUseWallet3(input) && this.wallet3 !== null;
  }

  private validateLaunchInput(input: TokenLaunchInput): void {
    const keys = this.resolveWalletKeys();
    if (resolveUseWallet3(input) && !keys.wallet3) {
      throw new Error('useWallet3 requires a third wallet (WALLET_3_PRIVATE_KEY or workflow wallet 3)');
    }
  }

  list(): TokenLaunchJob[] {
    return this.repository.list();
  }

  get(jobId: string): TokenLaunchJob | undefined {
    return this.repository.get(jobId);
  }

  private getOurWalletSet(): Set<string> {
    const wallets = new Set<string>();
    if (this.wallet1Address) wallets.add(this.wallet1Address.toLowerCase());
    if (this.wallet2Address) wallets.add(this.wallet2Address.toLowerCase());
    if (this.wallet3Address) wallets.add(this.wallet3Address.toLowerCase());
    return wallets;
  }

  async getTrades(jobId: string, refresh = false): Promise<TokenLaunchTradesResponse> {
    const job = this.repository.get(jobId);
    if (!job) throw new Error('Token launch job not found');
    if (!job.tokenAddress || !job.poolAddress) {
      throw new Error('Trades are not available until token and pool are created');
    }
    if (!refresh && job.trades && job.trades.length > 0) {
      return this.buildTradesResponse(job);
    }
    return this.syncTrades(jobId);
  }

  async backfillAllTrades(options?: { onlyMissing?: boolean }): Promise<TokenLaunchTradesBackfillResult> {
    if (!this.isConfigured()) {
      return { processed: 0, skipped: 0, failed: [] };
    }
    if (this.tradesBackfillRunning) {
      throw new Error('Trades backfill is already running');
    }
    this.ensureClients();
    this.tradesBackfillRunning = true;

    const result: TokenLaunchTradesBackfillResult = { processed: 0, skipped: 0, failed: [] };

    try {
      const jobs = this.repository
        .list()
        .filter((job) => job.tokenAddress && job.poolAddress);

      for (const job of jobs) {
        if (options?.onlyMissing && job.trades && job.trades.length > 0) {
          result.skipped += 1;
          continue;
        }

        try {
          await this.syncTrades(job.jobId);
          result.processed += 1;
        } catch (error) {
          result.failed.push({
            jobId: job.jobId,
            error: formatViemError(error)
          });
        }
        await sleep(TRADES_BACKFILL_JOB_DELAY_MS);
      }
    } finally {
      this.tradesBackfillRunning = false;
    }

    return result;
  }

  private buildTradesResponse(job: TokenLaunchJob): TokenLaunchTradesResponse {
    const trades = job.trades ?? [];
    return {
      jobId: job.jobId,
      tokenAddress: job.tokenAddress!,
      poolAddress: job.poolAddress!,
      trades,
      stats: computeTradeStats(trades),
      tradesSyncedAt: job.tradesSyncedAt
    };
  }

  async syncTrades(jobId: string): Promise<TokenLaunchTradesResponse> {
    this.ensureClients();
    const job = this.repository.get(jobId);
    if (!job) throw new Error('Token launch job not found');
    if (!job.tokenAddress || !job.poolAddress) {
      throw new Error('Trades are not available until token and pool are created');
    }

    const publicClient = this.publicClient!;
    const adapter = getDexAdapter(job.input.dex);
    const tokenAddress = getAddress(job.tokenAddress);
    const poolAddress = getAddress(job.poolAddress);
    const sinceMs = new Date(job.createdAt).getTime() - 60_000;
    const fromBlock = await withRpcRetry('resolve trade fromBlock', () =>
      resolveFromBlock(
        publicClient,
        job.deployTxHash as `0x${string}` | undefined,
        job.deployBlockNumber,
        sinceMs
      )
    );

    const fetched = await withRpcRetry(`pool trades for ${jobId}`, () =>
      fetchPoolTrades(publicClient, adapter, poolAddress, tokenAddress, fromBlock, this.getOurWalletSet())
    );

    const trades = mergeTrades(job.trades ?? [], fetched);
    const buyerCount = countExternalBuyersFromTrades(trades);
    const updated = this.patch(jobId, {
      trades,
      buyerCount,
      tradesSyncedAt: nowIso()
    });

    return this.buildTradesResponse(updated);
  }

  finish(jobId: string): TokenLaunchJob {
    const job = this.repository.get(jobId);
    if (!job) throw new Error('Token launch job not found');
    const activeStatuses = new Set<TokenLaunchJob['status']>([
      'pending',
      'deploying',
      'adding_liquidity',
      'monitoring',
      'buying',
      'removing_liquidity'
    ]);
    if (!activeStatuses.has(job.status)) {
      throw new Error('Only active launches can be finished');
    }

    this.clearRepeatBatch();
    const updated = this.patch(jobId, {
      status: 'completed',
      phase: 'Finished manually',
      completedAt: nowIso()
    });
    this.cancelled.add(jobId);
    return updated;
  }

  async manualBuy(jobId: string, wallet: 2 | 3, ethAmount?: string): Promise<TokenLaunchJob> {
    this.ensureClients();
    const job = this.repository.get(jobId);
    if (!job) throw new Error('Token launch job not found');
    if (job.status !== 'monitoring' && job.status !== 'buying') {
      throw new Error('Manual buy is only available while status is monitoring or buying');
    }
    if (!job.tokenAddress) throw new Error('Token not deployed yet');
    if (!job.poolAddress) throw new Error('Pool not ready yet');
    if (wallet === 3 && !this.jobUsesWallet3(job.input)) {
      throw new Error('Wallet 3 is not enabled for this launch');
    }

    const lockKey = `${jobId}:${wallet}`;
    if (this.manualBuyInFlight.has(lockKey)) {
      throw new Error(`Wallet ${wallet} buy already in progress for this launch`);
    }
    this.manualBuyInFlight.add(lockKey);

    try {
      const amountLabel =
        ethAmount?.trim() ||
        (wallet === 2 ? resolveWallet2BuyEthAmount(job.input) : job.input.buyEthAmount);
      const amount = parseEther(amountLabel);
      if (amount <= 0n) throw new Error('ethAmount must be greater than 0');

      const adapter = getDexAdapter(job.input.dex);
      const tokenAddress = getAddress(job.tokenAddress);
      const txHash = await this.swapEthForToken(adapter, wallet, tokenAddress, amount);
      const patch: Partial<TokenLaunchJob> = {
        phase: `Manual wallet ${wallet} buy complete (${amountLabel} ETH)`
      };
      if (wallet === 2) {
        patch.buyTxHash = txHash;
        patch.wallet2BuyExecuted = true;
      } else {
        patch.wallet3BuyTxHash = txHash;
        patch.wallet3BuyExecuted = true;
      }
      if (job.status === 'buying') patch.status = 'monitoring';
      return this.patch(jobId, patch);
    } finally {
      this.manualBuyInFlight.delete(lockKey);
    }
  }

  start(input: TokenLaunchInput): TokenLaunchJob {
    this.validateLaunchInput(input);
    this.ensureClients();
    const active = this.repository.findActive();
    if (active || this.repeatRemaining > 0) {
      throw new Error(`Token launch ${(active?.jobId ?? 'batch').slice(0, 8)}… is already running`);
    }

    this.repeatInput = input;
    this.repeatRemaining = input.repeatCount;
    return this.startNextRepeat();
  }

  private startNextRepeat(): TokenLaunchJob {
    const input = this.repeatInput;
    if (!input || this.repeatRemaining <= 0) {
      throw new Error('No token launch queued');
    }

    const repeatTotal = input.repeatCount;
    const repeatIndex = repeatTotal - this.repeatRemaining + 1;
    const job = this.repository.create(input, { repeatIndex, repeatTotal });
    this.broadcast?.(job, 'created');
    void this.run(job.jobId);
    return job;
  }

  private isLaunchReadyForNextRepeat(job: TokenLaunchJob | undefined): boolean {
    if (!job || job.status !== 'completed') return false;
    if (job.input.removeLp !== false && !job.lpRemoved) return false;
    return true;
  }

  private clearRepeatBatch(): void {
    this.repeatRemaining = 0;
    this.repeatInput = null;
  }

  private async maybeScheduleNextRepeat(jobId: string): Promise<void> {
    if (this.repeatRemaining <= 0 || !this.repeatInput) return;

    const job = this.repository.get(jobId);
    if (!this.isLaunchReadyForNextRepeat(job)) {
      console.warn(
        `Token launch repeat batch stopped: job ${jobId.slice(0, 8)}… did not fully complete` +
          (job?.input.removeLp !== false && !job?.lpRemoved ? ' (LP not removed)' : '') +
          `.`
      );
      this.clearRepeatBatch();
      return;
    }

    if (this.repeatRemaining <= 1) {
      this.clearRepeatBatch();
      return;
    }

    this.repeatRemaining -= 1;
    await sleep(REPEAT_DELAY_MS);

    if (this.repeatRemaining <= 0 || !this.repeatInput) return;

    try {
      this.startNextRepeat();
    } catch (error) {
      this.clearRepeatBatch();
      console.error('Failed to start next token launch repeat:', formatViemError(error));
    }
  }

  private ensureClients(): void {
    const keys = this.resolveWalletKeys();
    const wallet3Key = keys.wallet3;
    const wallet3Ready = Boolean(wallet3Key && this.wallet3 && this.wallet3Account);
    if (this.publicClient && this.wallet1 && this.wallet2 && this.wallet1Account && this.wallet2Account) {
      if (!wallet3Key || wallet3Ready) return;
    }

    const wallet1Key = keys.wallet1;
    const wallet2Key = keys.wallet2;
    if (!wallet1Key || !wallet2Key) {
      throw new Error('Wallet 1 and wallet 2 private keys must be configured');
    }

    const rpcUrl = process.env.BASE_RPC_URL?.trim() || 'https://rpc.mainnet.chain.robinhood.com';
    const transport = http(rpcUrl);
    this.publicClient = createPublicClient({ chain: BASE_CHAIN, transport });
    const account1 = privateKeyToAccount(normalizePrivateKey(wallet1Key));
    const account2 = privateKeyToAccount(normalizePrivateKey(wallet2Key));
    this.wallet1Account = account1;
    this.wallet2Account = account2;
    this.wallet1Address = account1.address;
    this.wallet2Address = account2.address;
    this.wallet1 = createWalletClient({ chain: BASE_CHAIN, transport, account: account1 });
    this.wallet2 = createWalletClient({ chain: BASE_CHAIN, transport, account: account2 });

    if (wallet3Key) {
      const account3 = privateKeyToAccount(normalizePrivateKey(wallet3Key));
      this.wallet3Account = account3;
      this.wallet3Address = account3.address;
      this.wallet3 = createWalletClient({ chain: BASE_CHAIN, transport, account: account3 });
    } else {
      this.wallet3Account = null;
      this.wallet3Address = null;
      this.wallet3 = null;
    }
  }

  private patch(jobId: string, patch: Partial<TokenLaunchJob>): TokenLaunchJob {
    if (this.cancelled.has(jobId)) {
      const job = this.repository.get(jobId);
      if (!job) throw new Error(`Token launch job ${jobId} not found`);
      return job;
    }
    const updated = this.repository.update(jobId, patch);
    if (!updated) throw new Error(`Token launch job ${jobId} not found`);
    this.broadcast?.(updated, 'updated');
    return updated;
  }

  private fail(jobId: string, error: unknown): void {
    const message = formatViemError(error);
    this.patch(jobId, {
      status: 'failed',
      error: message,
      completedAt: nowIso()
    });
  }

  private async ensureDeployReady(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    wallet1Address: Address,
    lpEthAmount: string
  ): Promise<void> {
    const balance = await publicClient.getBalance({ address: wallet1Address });
    // feeToken (AS) has a no-arg constructor; the deploy also creates the Uniswap V2 pair.
    const deployData = encodeDeployData({
      abi: feeTokenAbi,
      bytecode: feeTokenBytecode,
      args: []
    });

    let gasEstimate: bigint;
    try {
      gasEstimate = await publicClient.estimateGas({
        account: wallet1Address,
        data: deployData
      });
    } catch (error) {
      throw new Error(`Token deploy simulation failed: ${formatViemError(error)}`);
    }

    const gasPrice = await publicClient.getGasPrice();
    const deployCost = gasWithBuffer(gasEstimate, 500_000n) * gasPrice;
    const lpEth = parseEther(lpEthAmount);
    // Covers the token approval plus the addLiquidity gas reservation (which can be pre-charged
    // at the full limit on submission), so the up-front balance check matches what's needed.
    const postDeployGas = (ADD_LIQUIDITY_GAS_FLOOR + 300_000n) * gasPrice;
    const required = deployCost + lpEth + postDeployGas;

    if (balance < required) {
      throw new Error(
        `Wallet 1 needs at least ${(Number(required) / 1e18).toFixed(6)} ETH on Robinhood ` +
          `(${lpEthAmount} ETH LP + deploy/post-deploy gas; balance ${(Number(balance) / 1e18).toFixed(6)} ETH)`
      );
    }
  }

  private async swapEthForToken(
    adapter: DexAdapter,
    wallet: 2 | 3,
    tokenAddress: Address,
    buyEth: bigint
  ): Promise<`0x${string}`> {
    const publicClient = this.publicClient!;
    if (wallet === 3 && !this.wallet3) {
      throw new Error('Wallet 3 is not configured (set WALLET_3_PRIVATE_KEY in backend/.env)');
    }
    const walletClient = wallet === 2 ? this.wallet2! : this.wallet3!;
    const account = wallet === 2 ? this.wallet2Account! : this.wallet3Account!;
    const recipient = wallet === 2 ? this.wallet2Address! : this.wallet3Address!;
    const swapArgs = adapter.swapExactEthForTokensArgs({
      amountOutMin: 0n,
      token: tokenAddress,
      to: recipient,
      deadline: deadline()
    });

    const buyGas = await this.estimateWriteGas(
      publicClient,
      {
        account: recipient,
        address: adapter.router,
        abi: adapter.routerAbi,
        functionName: adapter.swapFunctionName,
        args: swapArgs,
        value: buyEth
      },
      350_000n
    );
    const buyHash = await this.sendTx(account, (nonce) =>
      walletClient.writeContract({
        account,
        chain: BASE_CHAIN,
        address: adapter.router,
        abi: adapter.routerAbi,
        functionName: adapter.swapFunctionName,
        args: swapArgs,
        value: buyEth,
        gas: buyGas,
        nonce
      })
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage(`Wallet ${wallet} buy failed`, receipt, buyHash));
    }
    return buyHash;
  }

  /**
   * True if the token still has `limitsEnabled` set. While it is, `_transfer` reverts for any
   * transfer between two non-exempt, non-owner addresses ("_transfer:: Trading is not active.",
   * since `tradingEnabled` starts false and can never be set — see feeTokenAbi). That blocks both
   * external buys and the pair->router burn leg of an LP removal.
   *
   * Returns false for a token without `readLimitsInfo()` (i.e. the plain LaunchToken), which has
   * no limits to lift.
   */
  private async tokenLimitsActive(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    tokenAddress: Address
  ): Promise<boolean> {
    try {
      const [limitsEnabled] = (await publicClient.readContract({
        address: tokenAddress,
        abi: feeTokenAbi,
        functionName: 'readLimitsInfo'
      })) as [boolean, bigint, bigint];
      return limitsEnabled;
    } catch {
      return false; // no such accessor — not the fee token, nothing to lift
    }
  }

  /**
   * Call the fee token's owner-only `removeLimitsNow()` to clear `limitsEnabled`, which unblocks
   * transfers for non-exempt addresses — required for buys AND for LP removal. Sent from wallet 1
   * (the deployer/owner). Throws on failure: nothing downstream works while limits are on.
   */
  private async removeTokenLimits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    tokenAddress: Address
  ): Promise<void> {
    if (!(await this.tokenLimitsActive(publicClient, tokenAddress))) return;

    const request = {
      account: wallet1Address,
      address: tokenAddress,
      abi: feeTokenAbi,
      functionName: 'removeLimitsNow'
    } as const;

    const gas = await this.estimateWriteGas(publicClient, request, 80_000n);
    const hash = await this.sendTx(wallet1Account, (nonce) =>
      wallet1.writeContract({ ...request, account: wallet1Account, chain: BASE_CHAIN, gas, nonce })
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage('Remove token limits (removeLimitsNow) failed', receipt, hash));
    }
  }

  /**
   * Lift the fee token's limits before an LP removal. While `limitsEnabled` is set, the pair->router
   * burn transfer reverts ("_transfer:: Trading is not active.") and the router reports the useless
   * "UniswapV2: TRANSFER_FAILED" — so this is a hard precondition for removal, not a nicety.
   *
   * A no-op when the token has no limits (plain LaunchToken) or they are already lifted. If wallet 1
   * cannot lift them (not the owner), it throws rather than proceeding into a guaranteed revert.
   */
  private async liftTokenLimitsForRemoval(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    tokenAddress: Address
  ): Promise<void> {
    if (!(await this.tokenLimitsActive(publicClient, tokenAddress))) return;

    try {
      await this.removeTokenLimits(publicClient, wallet1, wallet1Account, wallet1Address, tokenAddress);
    } catch (error) {
      throw new Error(
        `Token ${tokenAddress} still has transfer limits enabled and they could not be lifted ` +
          `(removeLimitsNow is owner-only — wallet 1 must be the token owner). ` +
          `LP removal cannot succeed until they are: ${describeError(error)}`
      );
    }

    if (await this.tokenLimitsActive(publicClient, tokenAddress)) {
      throw new Error(
        `Token ${tokenAddress} still reports limitsEnabled after removeLimitsNow(); LP removal would ` +
          `revert with "UniswapV2: TRANSFER_FAILED" (underlying: "_transfer:: Trading is not active.")`
      );
    }
  }

  /**
   * Best-effort limit lift for the manual add-liquidity path, where the token may be one wallet 1
   * does not own (so `removeLimitsNow()` is not callable). Adding liquidity itself still works —
   * the owner/deployer is exempt — so a failure here is a warning, not a hard stop. Removal has its
   * own strict check.
   */
  private async tryLiftTokenLimits(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    tokenAddress: Address
  ): Promise<void> {
    try {
      await this.removeTokenLimits(publicClient, wallet1, wallet1Account, wallet1Address, tokenAddress);
    } catch (error) {
      console.warn(`Lift token limits failed for ${tokenAddress}:`, describeError(error));
    }
  }

  /**
   * Broadcast a write transaction with an explicit, collision-safe nonce. `send` receives the
   * nonce to attach (pass it straight to writeContract/deployContract) and returns the tx hash.
   * Sends from the same account are serialized; on a nonce mismatch we re-sync from chain and
   * resend. This does NOT wait for the receipt — callers await that as before.
   */
  private async sendTx(
    account: ReturnType<typeof privateKeyToAccount>,
    send: (nonce: number) => Promise<`0x${string}`>
  ): Promise<`0x${string}`> {
    const address = account.address;
    const prior = this.nonceQueue.get(address) ?? Promise.resolve();
    const run = prior.then(
      () => this.sendTxSerialized(address, send),
      () => this.sendTxSerialized(address, send)
    );
    // Keep the queue tail non-throwing so one failed send doesn't poison later ones.
    this.nonceQueue.set(
      address,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  private async sendTxSerialized(
    address: Address,
    send: (nonce: number) => Promise<`0x${string}`>
  ): Promise<`0x${string}`> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= NONCE_RETRY_ATTEMPTS; attempt += 1) {
      const onchain = Number(
        await this.publicClient.getTransactionCount({ address, blockTag: 'pending' })
      );
      const local = this.nonceCursor.get(address) ?? 0;
      // Never go below our own last-used nonce: a lagging RPC node can report a stale-low pending
      // count right after a receipt, which is exactly what triggers "nonce too low".
      const nonce = Math.max(onchain, local);
      try {
        const hash = await send(nonce);
        this.nonceCursor.set(address, nonce + 1);
        return hash;
      } catch (error) {
        lastError = error;
        if (!isNonceError(error) || attempt === NONCE_RETRY_ATTEMPTS) break;
        // Re-sync from chain next iteration and let the lagging node catch up.
        this.nonceCursor.delete(address);
        await sleep(NONCE_RETRY_MS * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Transaction send failed: ${String(lastError)}`);
  }

  private async estimateWriteGas(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    request: Parameters<typeof publicClient.estimateContractGas>[0],
    floor: bigint
  ): Promise<bigint> {
    for (let attempt = 1; attempt <= GAS_ESTIMATE_ATTEMPTS; attempt += 1) {
      try {
        const estimate = await publicClient.estimateContractGas(request);
        return gasWithBuffer(estimate, floor);
      } catch {
        if (attempt < GAS_ESTIMATE_ATTEMPTS) await sleep(GAS_ESTIMATE_RETRY_MS);
      }
    }
    return floor;
  }

  private async run(jobId: string): Promise<void> {
    if (this.running.has(jobId)) return;
    this.running.add(jobId);

    try {
      const publicClient = this.publicClient!;
      const wallet1 = this.wallet1!;
      const wallet1Address = this.wallet1Address!;
      const wallet2Address = this.wallet2Address!;
      const job = this.repository.get(jobId);
      if (!job) return;
      const adapter = getDexAdapter(job.input.dex);

      this.patch(jobId, { status: 'deploying', phase: 'Deploying token' });

      const wallet1Account = this.wallet1Account!;

      await this.ensureDeployReady(publicClient, wallet1Address, job.input.lpEthAmount);

      // feeToken (AS) constructor takes no args — name/symbol/supply are hardcoded in the
      // contract (Asteroid Shiba / ASTEROID, 9 decimals) and it creates the V2 pair itself.
      const deployHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.deployContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          abi: feeTokenAbi,
          bytecode: feeTokenBytecode,
          args: [],
          nonce
        })
      );

      const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
      if (deployReceipt.status !== 'success') {
        throw new Error('Token deployment failed');
      }

      const tokenAddress = deployReceipt.contractAddress;
      if (!tokenAddress) {
        throw new Error('Token deployment did not return a contract address');
      }

      this.patch(jobId, {
        tokenAddress,
        deployTxHash: deployHash,
        deployBlockNumber: Number(deployReceipt.blockNumber),
        status: 'adding_liquidity',
        phase: `Creating ${adapter.label} LP`
      });

      // Deployer (wallet 1) is minted the entire supply and is tax-exempt in the contract,
      // so adding liquidity from it incurs no transfer fee. Put all of it into the LP.
      const tokenAmount = (await publicClient.readContract({
        address: tokenAddress,
        abi: feeTokenAbi,
        functionName: 'balanceOf',
        args: [wallet1Address]
      })) as bigint;
      if (tokenAmount <= 0n) {
        throw new Error('Deployer holds no token balance after deploy');
      }

      const approveGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: tokenAddress,
          abi: feeTokenAbi,
          functionName: 'approve',
          args: [adapter.router, tokenAmount]
        },
        80_000n
      );
      const approveHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          address: tokenAddress,
          abi: feeTokenAbi,
          functionName: 'approve',
          args: [adapter.router, tokenAmount],
          gas: approveGas,
          nonce
        })
      );
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') {
        throw new Error(
          receiptFailureMessage(`Token approval for ${adapter.label} router failed`, approveReceipt, approveHash)
        );
      }

      const lpEth = parseEther(job.input.lpEthAmount);
      const addLiquidityArgs = adapter.addLiquidityEthArgs({
        token: tokenAddress,
        tokenAmount,
        amountTokenMin: 0n,
        amountEthMin: 0n,
        to: wallet1Address,
        deadline: deadline()
      });
      const addLiquidityGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: adapter.router,
          abi: adapter.routerAbi,
          functionName: 'addLiquidityETH',
          args: addLiquidityArgs,
          value: lpEth
        },
        ADD_LIQUIDITY_GAS_FLOOR
      );
      const addLiquidityHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          address: adapter.router,
          abi: adapter.routerAbi,
          functionName: 'addLiquidityETH',
          args: addLiquidityArgs,
          value: lpEth,
          gas: addLiquidityGas,
          nonce
        })
      );
      const addLiquidityReceipt = await publicClient.waitForTransactionReceipt({ hash: addLiquidityHash });
      if (addLiquidityReceipt.status !== 'success') {
        throw new Error(receiptFailureMessage('Add liquidity transaction failed', addLiquidityReceipt, addLiquidityHash));
      }

      // Unlock the fee token (owner-only removeLimitsNow). It deploys with limitsEnabled=true and
      // tradingEnabled=false, so until this lands EVERY non-exempt transfer reverts with
      // "_transfer:: Trading is not active." — no external buyer can buy, and LP removal reverts.
      await this.removeTokenLimits(publicClient, wallet1, wallet1Account, wallet1Address, tokenAddress);

      const poolAddress = await this.resolvePoolAddress(publicClient, adapter, tokenAddress, addLiquidityReceipt);

      const monitorStartedAt = Date.now();
      this.patch(jobId, {
        poolAddress,
        addLiquidityTxHash: addLiquidityHash,
        status: 'monitoring',
        phase: 'Monitoring buyers'
      });

      // buyerCount = external buyers seen (incl. sub-threshold dust, for display);
      // qualifyingBuyers = buyers meeting MIN_DETECTION_BUY_ETH, which actually drive detection.
      let buyerCount = 0;
      let qualifyingBuyers = 0;
      let lpRemoved = false;
      let wallet2BuyExecuted = false;
      let wallet3BuyExecuted = false;
      const shouldRemoveLp = job.input.removeLp !== false;
      const removeLpTimeMinutes = resolveRemoveLpTimeMinutes(job.input);
      const removeLpTimeLabel = formatRemoveLpTime(removeLpTimeMinutes);
      const monitorDurationMs = removeLpMonitorMs(job.input);
      const minBuyersBeforeRemoveLp = resolveMinBuyersBeforeRemoveLp(job.input);
      const useWallet3 = this.jobUsesWallet3(job.input);
      const buyAfterMs = resolveBuyAfterMs(job.input);
      const wallet2BuyEth = resolveWallet2BuyEthAmount(job.input);

      const buyerThresholdMet = (count: number) => count >= minBuyersBeforeRemoveLp;
      const buyerMonitorPhase = () => {
        const dust = buyerCount - qualifyingBuyers;
        const seenLabel = dust > 0 ? ` · ${dust} dust ignored` : '';
        return minBuyersBeforeRemoveLp > 1
          ? `Monitoring buyers (${qualifyingBuyers}/${minBuyersBeforeRemoveLp} for early exit${seenLabel})`
          : `Monitoring buyers (${qualifyingBuyers} detected${seenLabel})`;
      };

      const removeLiquidity = async (reason: string): Promise<void> => {
        if (lpRemoved) return;
        this.patch(jobId, { status: 'removing_liquidity', phase: reason });

        const removeHash = await this.removePoolLiquidity(
          publicClient,
          adapter,
          wallet1,
          wallet1Account,
          wallet1Address,
          tokenAddress,
          poolAddress
        );
        if (removeHash) {
          this.patch(jobId, { removeLiquidityTxHash: removeHash, lpRemoved: true });
        } else {
          this.patch(jobId, { lpRemoved: true });
        }

        lpRemoved = true;
      };

      while (Date.now() - monitorStartedAt < monitorDurationMs) {
        if (this.cancelled.has(jobId)) return;
        const elapsed = Date.now() - monitorStartedAt;
        try {
          const synced = await this.syncTrades(jobId);
          buyerCount = synced.stats.externalBuyers;
          qualifyingBuyers = synced.stats.qualifyingBuyers;
        } catch (error) {
          console.error(`Trade sync failed for ${jobId}:`, formatViemError(error));
        }
        this.patch(jobId, { buyerCount, phase: buyerMonitorPhase() });

        if (buyerThresholdMet(qualifyingBuyers)) {
          if (shouldRemoveLp) {
            await removeLiquidity(
              minBuyersBeforeRemoveLp > 1
                ? `Removing LP after ${qualifyingBuyers} buyers (min ${minBuyersBeforeRemoveLp})`
                : 'Removing LP after buyer detected'
            );
            this.patch(jobId, {
              status: 'completed',
              lpRemoved: true,
              buyerCount,
              phase:
                minBuyersBeforeRemoveLp > 1
                  ? `Completed — LP removed after ${qualifyingBuyers} buyers`
                  : 'Completed — LP removed after buyer',
              completedAt: nowIso()
            });
          } else {
            this.patch(jobId, {
              status: 'completed',
              buyerCount,
              phase:
                minBuyersBeforeRemoveLp > 1
                  ? `Completed — ${qualifyingBuyers} buyers, LP kept (remove manually)`
                  : 'Completed — buyer detected, LP kept (remove manually)',
              completedAt: nowIso()
            });
          }
          return;
        }

        if (!wallet2BuyExecuted && qualifyingBuyers === 0 && elapsed >= buyAfterMs) {
          const buyLabel = useWallet3 ? 'wallets 2 & 3' : 'wallet 2';
          this.patch(jobId, { status: 'buying', phase: `No buyers — buying with ${buyLabel}` });
          const buy2Hash = await this.swapEthForToken(adapter, 2, tokenAddress, parseEther(wallet2BuyEth));
          wallet2BuyExecuted = true;
          const patch: Partial<TokenLaunchJob> = {
            buyTxHash: buy2Hash,
            wallet2BuyExecuted: true,
            status: 'monitoring',
            phase: useWallet3
              ? `Wallets 2 & 3 buy complete — monitoring until ${removeLpTimeLabel}`
              : `Wallet 2 buy complete — monitoring until ${removeLpTimeLabel}`
          };
          if (useWallet3) {
            const buy3Hash = await this.swapEthForToken(adapter, 3, tokenAddress, parseEther(job.input.buyEthAmount));
            wallet3BuyExecuted = true;
            patch.wallet3BuyTxHash = buy3Hash;
            patch.wallet3BuyExecuted = true;
          }
          this.patch(jobId, patch);
        }

        await sleep(SWAP_POLL_MS);
      }

      if (this.cancelled.has(jobId)) return;

      if (shouldRemoveLp) {
        await removeLiquidity(`Removing LP after ${removeLpTimeLabel}`);
        if (this.cancelled.has(jobId)) return;
        this.patch(jobId, {
          status: 'completed',
          lpRemoved: true,
          buyerCount,
          wallet2BuyExecuted,
          wallet3BuyExecuted,
          phase:
            wallet2BuyExecuted || wallet3BuyExecuted
              ? `Completed — own wallets bought, LP removed after ${removeLpTimeLabel}`
              : `Completed — LP removed after ${removeLpTimeLabel}`,
          completedAt: nowIso()
        });
      } else {
        this.patch(jobId, {
          status: 'completed',
          buyerCount,
          wallet2BuyExecuted,
          wallet3BuyExecuted,
          phase:
            wallet2BuyExecuted || wallet3BuyExecuted
              ? 'Completed — own wallets bought, LP kept (remove manually)'
              : 'Completed — LP kept (remove manually)',
          completedAt: nowIso()
        });
      }
    } catch (error) {
      this.fail(jobId, error);
    } finally {
      this.running.delete(jobId);
      void this.maybeScheduleNextRepeat(jobId);
    }
  }

  private poolFromReceipt(adapter: DexAdapter, receipt: TransactionReceipt, tokenAddress: Address): Address | null {
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(adapter.factory)) continue;
      try {
        const decoded = decodeEventLog({
          abi: adapter.factoryAbi,
          data: log.data,
          topics: log.topics
        });
        if (decoded.eventName !== adapter.poolCreatedEventName) continue;
        const { pool, token0, token1 } = adapter.parseCreatedPool(
          decoded.args as unknown as Record<string, unknown>
        );
        const token = getAddress(tokenAddress);
        if (getAddress(token0) === token || getAddress(token1) === token) {
          return getAddress(pool);
        }
      } catch {
        // Not a pool/pair-creation log for this ABI decode attempt.
      }
    }
    return null;
  }

  private async readPoolAddress(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    adapter: DexAdapter,
    tokenAddress: Address
  ): Promise<Address | null> {
    for (const [tokenA, tokenB] of [
      [adapter.weth, tokenAddress],
      [tokenAddress, adapter.weth]
    ] as const) {
      const pool = (await client.readContract({
        address: adapter.factory,
        abi: adapter.factoryAbi,
        functionName: adapter.getPoolFunctionName,
        args: adapter.getPoolArgs(tokenA, tokenB)
      })) as Address;
      if (pool && getAddress(pool) !== zeroAddress) {
        return getAddress(pool);
      }
    }
    return null;
  }

  private async resolvePoolAddress(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    adapter: DexAdapter,
    tokenAddress: Address,
    receipt?: TransactionReceipt
  ): Promise<Address> {
    if (receipt) {
      const fromReceipt = this.poolFromReceipt(adapter, receipt, tokenAddress);
      if (fromReceipt) return fromReceipt;
    }

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const pool = await this.readPoolAddress(client, adapter, tokenAddress);
      if (pool) return pool;
      await sleep(500);
    }

    throw new Error(`${adapter.label} pool was not created`);
  }

  /**
   * Read wallet 1's LP-token balance for a pool, returning null for any address that isn't a
   * live contract on the CURRENT chain. Legacy jobs created on a previous chain (e.g. Base,
   * before the switch to Robinhood) leave pool addresses with no code on the active RPC, and
   * reading balanceOf there throws "returned no data (0x)". Skipping those keeps one stale
   * address from breaking the whole stranded-LP scan or a remove-all. Genuine read errors on a
   * real (code-bearing) pool still propagate.
   */
  private async readPoolLpBalance(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    adapter: DexAdapter,
    poolAddress: Address,
    owner: Address
  ): Promise<bigint | null> {
    const code = (await withRpcRetry(`pool code for ${poolAddress}`, () =>
      client.getBytecode({ address: poolAddress })
    )) as string | undefined;
    if (!code || code === '0x') return null;
    return (await withRpcRetry(`LP balance for ${poolAddress}`, () =>
      client.readContract({
        address: poolAddress,
        abi: adapter.poolAbi,
        functionName: 'balanceOf',
        args: [owner]
      })
    )) as bigint;
  }

  async listUnremovedLp(): Promise<UnremovedLpPosition[]> {
    this.ensureClients();
    const publicClient = this.publicClient!;
    const wallet1Address = this.wallet1Address!;
    const candidates = this.collectPoolCandidates();
    const positions: UnremovedLpPosition[] = [];

    for (const [poolAddress, meta] of candidates) {
      await sleep(LP_SCAN_DELAY_MS);
      const adapter = getDexAdapter(meta.dex);
      const lpBalance = await this.readPoolLpBalance(publicClient, adapter, poolAddress, wallet1Address);
      if (lpBalance === null || lpBalance <= 0n) continue;

      const tokenAddress = meta.tokenAddress ?? (await this.resolveTokenFromPool(publicClient, adapter, poolAddress));
      positions.push({
        poolAddress,
        tokenAddress,
        lpBalance: lpBalance.toString(),
        jobIds: meta.jobIds,
        tokenName: meta.tokenName,
        tokenSymbol: meta.tokenSymbol,
        dex: adapter.key
      });
    }

    return positions;
  }

  /** Resolve one pool's LP position without scanning every historical pool (used for single-pool removal). */
  private async resolveSinglePosition(poolAddress: Address): Promise<UnremovedLpPosition | null> {
    const publicClient = this.publicClient!;
    const wallet1Address = this.wallet1Address!;
    const meta = this.collectPoolCandidates().get(poolAddress);
    const adapter = getDexAdapter(meta?.dex);
    const lpBalance = await this.readPoolLpBalance(publicClient, adapter, poolAddress, wallet1Address);
    if (lpBalance === null || lpBalance <= 0n) return null;
    const tokenAddress = meta?.tokenAddress ?? (await this.resolveTokenFromPool(publicClient, adapter, poolAddress));
    return {
      poolAddress,
      tokenAddress,
      lpBalance: lpBalance.toString(),
      jobIds: meta?.jobIds ?? [],
      tokenName: meta?.tokenName,
      tokenSymbol: meta?.tokenSymbol,
      dex: adapter.key
    };
  }

  async removeUnremovedLp(options: { poolAddress?: string; all?: boolean }): Promise<LpRemovalResult[]> {
    this.ensureClients();

    let targets: UnremovedLpPosition[];
    if (options.poolAddress) {
      // Fast path: resolve just this pool instead of scanning every past pool first.
      const position = await this.resolveSinglePosition(getAddress(options.poolAddress));
      if (!position) {
        throw new Error('No LP balance found for that pool on wallet 1');
      }
      targets = [position];
    } else if (options.all) {
      targets = await this.listUnremovedLp();
      if (targets.length === 0) return [];
    } else {
      throw new Error('Provide poolAddress or set all=true');
    }

    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const wallet1Address = this.wallet1Address!;
    const results: LpRemovalResult[] = [];

    for (const position of targets) {
      const poolAddress = getAddress(position.poolAddress);
      const tokenAddress = getAddress(position.tokenAddress);
      const adapter = getDexAdapter(position.dex);
      try {
        const txHash = await this.removePoolLiquidity(
          publicClient,
          adapter,
          wallet1,
          wallet1Account,
          wallet1Address,
          tokenAddress,
          poolAddress
        );
        if (txHash) {
          const updatedJobs = this.repository.markLpRemovedForPool(poolAddress, txHash);
          for (const job of updatedJobs) {
            this.broadcast?.(job, 'updated');
          }
        }
        results.push({
          poolAddress,
          tokenAddress,
          txHash: txHash ?? undefined,
          success: true
        });
      } catch (error) {
        results.push({
          poolAddress,
          tokenAddress,
          success: false,
          error: formatViemError(error)
        });
      }
      await sleep(LP_SCAN_DELAY_MS);
    }

    return results;
  }

  // ---------------------------------------------------------------------------------------
  // Manual token deploy (dashboard "Manual Launch" page). Deploys the contract from wallet 1
  // and stops there — no LP, no monitoring. Uses the shared nonce queue, so it is safe while
  // an auto launch is mid-flight.
  // ---------------------------------------------------------------------------------------

  listDeployedTokens(): DeployedTokenRecord[] {
    return this.deployRepository.list();
  }

  async deployManualToken(input: ManualTokenDeployInput): Promise<DeployedTokenRecord> {
    this.ensureClients();
    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const wallet1Address = this.wallet1Address!;

    const isTax = input.tokenType === 'tax';
    const normalArgs = isTax
      ? null
      : ([input.tokenName!, input.tokenSymbol!, parseUnits(input.totalSupply!, 18)] as const);

    const deployData = isTax
      ? encodeDeployData({ abi: feeTokenAbi, bytecode: feeTokenBytecode, args: [] })
      : encodeDeployData({ abi: launchTokenAbi, bytecode: launchTokenBytecode, args: normalArgs! });

    let gasEstimate: bigint;
    try {
      gasEstimate = await publicClient.estimateGas({ account: wallet1Address, data: deployData });
    } catch (error) {
      throw new Error(`Token deploy simulation failed: ${describeError(error)}`);
    }
    const [gasPrice, balance] = await Promise.all([
      publicClient.getGasPrice(),
      publicClient.getBalance({ address: wallet1Address })
    ]);
    const required = gasWithBuffer(gasEstimate, 500_000n) * gasPrice;
    if (balance < required) {
      throw new Error(
        `Wallet 1 needs ~${formatEther(required)} ETH for deploy gas; balance ${formatEther(balance)} ETH`
      );
    }

    const deployHash = await this.sendTx(wallet1Account, (nonce) =>
      isTax
        ? wallet1.deployContract({
            account: wallet1Account,
            chain: BASE_CHAIN,
            abi: feeTokenAbi,
            bytecode: feeTokenBytecode,
            args: [],
            nonce
          })
        : wallet1.deployContract({
            account: wallet1Account,
            chain: BASE_CHAIN,
            abi: launchTokenAbi,
            bytecode: launchTokenBytecode,
            args: normalArgs!,
            nonce
          })
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage('Token deployment failed', receipt, deployHash));
    }
    const tokenAddress = receipt.contractAddress;
    if (!tokenAddress) {
      throw new Error('Token deployment did not return a contract address');
    }

    // Read the deployed name/symbol so the record shows the contract's real values — the tax
    // contract hardcodes its own and ignores whatever the form says.
    const readMeta = async (functionName: 'name' | 'symbol'): Promise<string | undefined> => {
      try {
        const value = await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName });
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    };
    const [onChainName, onChainSymbol] = await Promise.all([readMeta('name'), readMeta('symbol')]);

    return this.deployRepository.create({
      tokenType: input.tokenType,
      tokenAddress: getAddress(tokenAddress),
      tokenName: onChainName ?? input.tokenName,
      tokenSymbol: onChainSymbol ?? input.tokenSymbol,
      totalSupply: isTax ? undefined : input.totalSupply,
      deployTxHash: deployHash,
      deployerAddress: wallet1Address
    });
  }

  // ---------------------------------------------------------------------------------------
  // Manual liquidity (dashboard "Liquidity" page). Runs on wallet 1 through the same nonce
  // queue as the launch flow, so it is safe to use while a launch is mid-flight.
  // ---------------------------------------------------------------------------------------

  private async readTokenMeta(tokenAddress: Address): Promise<{ symbol?: string; decimals: number }> {
    const publicClient = this.publicClient!;
    const code = (await withRpcRetry(`token code for ${tokenAddress}`, () =>
      publicClient.getBytecode({ address: tokenAddress })
    )) as string | undefined;
    if (!code || code === '0x') {
      throw new Error(`No contract at ${tokenAddress} on ${BASE_CHAIN.name} (chain ${BASE_CHAIN.id})`);
    }

    const read = async (functionName: 'symbol' | 'decimals'): Promise<unknown> => {
      try {
        return await publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName });
      } catch {
        return undefined;
      }
    };
    const [decimals, symbol] = await Promise.all([read('decimals'), read('symbol')]);
    if (decimals === undefined) {
      throw new Error(`${tokenAddress} does not answer decimals() — it is not an ERC-20 token`);
    }
    return { decimals: Number(decimals), symbol: typeof symbol === 'string' ? symbol : undefined };
  }

  /** Wallet 1's LP balance for a pool plus its share of the reserves. Null when the pool has no code. */
  private async readLpBalances(
    adapter: DexAdapter,
    poolAddress: Address,
    tokenAddress: Address
  ): Promise<{ lpBalance: bigint; pooledToken?: bigint; pooledEth?: bigint } | null> {
    const publicClient = this.publicClient!;
    const lpBalance = await this.readPoolLpBalance(publicClient, adapter, poolAddress, this.wallet1Address!);
    if (lpBalance === null) return null;

    try {
      const [totalSupply, reserves, token0] = (await Promise.all([
        publicClient.readContract({ address: poolAddress, abi: adapter.poolAbi, functionName: 'totalSupply' }),
        publicClient.readContract({ address: poolAddress, abi: adapter.poolAbi, functionName: 'getReserves' }),
        publicClient.readContract({ address: poolAddress, abi: adapter.poolAbi, functionName: 'token0' })
      ])) as [bigint, readonly bigint[], Address];
      if (totalSupply <= 0n) return { lpBalance };

      const tokenIs0 = getAddress(token0) === getAddress(tokenAddress);
      const tokenReserve = tokenIs0 ? reserves[0] : reserves[1];
      const ethReserve = tokenIs0 ? reserves[1] : reserves[0];
      return {
        lpBalance,
        pooledToken: (tokenReserve * lpBalance) / totalSupply,
        pooledEth: (ethReserve * lpBalance) / totalSupply
      };
    } catch {
      // Reserves are cosmetic — a pool that doesn't expose them still removes fine.
      return { lpBalance };
    }
  }

  private toLpPosition(
    record: ManualLpRecord,
    balances: { lpBalance: bigint; pooledToken?: bigint; pooledEth?: bigint }
  ): LpPosition {
    const decimals = record.tokenDecimals ?? 18;
    return {
      ...record,
      lpBalance: balances.lpBalance.toString(),
      pooledToken: balances.pooledToken === undefined ? undefined : formatUnits(balances.pooledToken, decimals),
      pooledEth: balances.pooledEth === undefined ? undefined : formatEther(balances.pooledEth)
    };
  }

  private async findPoolForToken(
    tokenAddress: Address
  ): Promise<{ adapter: DexAdapter; poolAddress: Address } | null> {
    const publicClient = this.publicClient!;
    for (const adapter of DEX_ADAPTERS) {
      try {
        const poolAddress = await this.readPoolAddress(publicClient, adapter, tokenAddress);
        if (poolAddress) return { adapter, poolAddress };
      } catch {
        // The factory has no code on this chain (Aerodrome is Base-only) — it hosts no pool here.
      }
    }
    return null;
  }

  private async approveToken(tokenAddress: Address, spender: Address, amount: bigint): Promise<`0x${string}`> {
    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const request = {
      account: this.wallet1Address!,
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount]
    } as const;

    const gas = await this.estimateWriteGas(publicClient, request, 80_000n);
    const hash = await this.sendTx(wallet1Account, (nonce) =>
      wallet1.writeContract({ ...request, account: wallet1Account, chain: BASE_CHAIN, gas, nonce })
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: REMOVE_RECEIPT_TIMEOUT_MS
    });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage('Token approval failed', receipt, hash));
    }
    return hash;
  }

  /** Saved manual LP positions that wallet 1 still holds. Rows whose LP is gone are dropped. */
  async listSavedLp(): Promise<LpPosition[]> {
    this.ensureClients();
    const positions: LpPosition[] = [];

    for (const record of this.lpRepository.list()) {
      const adapter = getDexAdapter(record.dex);
      const balances = await this.readLpBalances(
        adapter,
        getAddress(record.poolAddress),
        getAddress(record.tokenAddress)
      );
      if (!balances) continue; // pool has no code on this chain — leave the row for a later scan
      if (balances.lpBalance <= 0n) {
        this.lpRepository.remove(record.poolAddress);
        continue;
      }
      positions.push(this.toLpPosition(record, balances));
    }

    return positions;
  }

  /** Preview the LP wallet 1 holds for a token, so the UI can confirm before removing. */
  async findLpByToken(rawTokenAddress: string): Promise<LpPosition | null> {
    this.ensureClients();
    const tokenAddress = getAddress(rawTokenAddress);
    const { decimals, symbol } = await this.readTokenMeta(tokenAddress);

    const found = await this.findPoolForToken(tokenAddress);
    if (!found) return null;

    const balances = await this.readLpBalances(found.adapter, found.poolAddress, tokenAddress);
    if (!balances || balances.lpBalance <= 0n) return null;

    const record = this.lpRepository.get(found.poolAddress) ?? {
      poolAddress: found.poolAddress,
      tokenAddress,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      dex: found.adapter.key,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    return this.toLpPosition(record, balances);
  }

  async addLiquidity(input: AddLiquidityInput): Promise<AddLiquidityResult> {
    this.ensureClients();
    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const wallet1Address = this.wallet1Address!;
    const adapter = getDexAdapter(DEFAULT_DEX);
    const tokenAddress = getAddress(input.tokenAddress);

    const { decimals, symbol } = await this.readTokenMeta(tokenAddress);
    const unit = symbol || 'tokens';
    const tokenAmount = parseUnits(input.tokenAmount, decimals);
    const ethAmount = parseEther(input.ethAmount);
    if (tokenAmount <= 0n) throw new Error('tokenAmount must be greater than 0');
    if (ethAmount <= 0n) throw new Error('ethAmount must be greater than 0');

    const [tokenBalance, ethBalance, gasPrice] = (await Promise.all([
      publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet1Address]
      }),
      publicClient.getBalance({ address: wallet1Address }),
      publicClient.getGasPrice()
    ])) as [bigint, bigint, bigint];

    if (tokenBalance < tokenAmount) {
      throw new Error(
        `Wallet 1 holds ${formatUnits(tokenBalance, decimals)} ${unit}, needs ${input.tokenAmount}`
      );
    }
    // Creating a new pair costs ~3M gas and the limit can be pre-charged in full on submission,
    // so require liquidity + the whole gas reservation up front.
    const requiredEth = ethAmount + (ADD_LIQUIDITY_GAS_FLOOR + 200_000n) * gasPrice;
    if (ethBalance < requiredEth) {
      throw new Error(
        `Wallet 1 needs ~${formatEther(requiredEth)} ETH (${input.ethAmount} ETH liquidity + gas); ` +
          `balance ${formatEther(ethBalance)} ETH`
      );
    }

    // Fee tokens cap max-wallet/max-tx at a few percent of supply, which makes the router→pair
    // transfer revert. Lift the caps when wallet 1 owns the token; a no-op for every other token.
    await this.tryLiftTokenLimits(publicClient, wallet1, wallet1Account, wallet1Address, tokenAddress);

    const allowance = (await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [wallet1Address, adapter.router]
    })) as bigint;
    const approveTxHash =
      allowance < tokenAmount ? await this.approveToken(tokenAddress, adapter.router, tokenAmount) : undefined;

    const request = {
      account: wallet1Address,
      address: adapter.router,
      abi: adapter.routerAbi,
      functionName: 'addLiquidityETH',
      // Zero minimums: a fee-on-transfer token delivers less than `tokenAmount` to the pair, and a
      // non-zero minimum would make the router's exact-amount check revert.
      args: adapter.addLiquidityEthArgs({
        token: tokenAddress,
        tokenAmount,
        amountTokenMin: 0n,
        amountEthMin: 0n,
        to: wallet1Address,
        deadline: deadline()
      }),
      value: ethAmount
    };

    // Simulate first so a revert surfaces its reason instead of silently burning gas on-chain.
    try {
      await publicClient.simulateContract(request);
    } catch (error) {
      throw new Error(`Add liquidity would revert: ${describeError(error)}`);
    }

    const gas = await this.estimateWriteGas(publicClient, request, ADD_LIQUIDITY_GAS_FLOOR);
    const addTxHash = await this.sendTx(wallet1Account, (nonce) =>
      wallet1.writeContract({ ...request, account: wallet1Account, chain: BASE_CHAIN, gas, nonce })
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: addTxHash,
      timeout: REMOVE_RECEIPT_TIMEOUT_MS
    });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage('Add liquidity transaction reverted', receipt, addTxHash));
    }

    const poolAddress = await this.resolvePoolAddress(publicClient, adapter, tokenAddress, receipt);
    const record = this.lpRepository.upsert({
      poolAddress,
      tokenAddress,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      dex: adapter.key,
      addTxHash
    });
    const balances = (await this.readLpBalances(adapter, poolAddress, tokenAddress)) ?? { lpBalance: 0n };

    return { position: this.toLpPosition(record, balances), approveTxHash, addTxHash };
  }

  async removeLiquidity(input: RemoveLiquidityInput): Promise<LpRemovalResult> {
    this.ensureClients();
    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const wallet1Address = this.wallet1Address!;

    let adapter: DexAdapter;
    let poolAddress: Address;
    let tokenAddress: Address;

    if (input.poolAddress) {
      poolAddress = getAddress(input.poolAddress);
      const saved = this.lpRepository.get(poolAddress);
      adapter = getDexAdapter(saved?.dex ?? DEFAULT_DEX);
      tokenAddress = saved
        ? getAddress(saved.tokenAddress)
        : await this.resolveTokenFromPool(publicClient, adapter, poolAddress);
    } else if (input.tokenAddress) {
      tokenAddress = getAddress(input.tokenAddress);
      await this.readTokenMeta(tokenAddress); // fail fast with "no contract" / "not an ERC-20"
      const found = await this.findPoolForToken(tokenAddress);
      if (!found) {
        throw new Error(`No Uniswap V2 or Aerodrome pool found for ${tokenAddress}`);
      }
      ({ adapter, poolAddress } = found);
    } else {
      throw new Error('Provide a pool address or a token address');
    }

    const lpBalance = await this.readPoolLpBalance(publicClient, adapter, poolAddress, wallet1Address);
    if (lpBalance !== null && lpBalance <= 0n) {
      this.lpRepository.remove(poolAddress); // nothing left to remove — stop listing it
    }
    if (lpBalance === null || lpBalance <= 0n) {
      throw new Error(`Wallet 1 holds no LP for pool ${poolAddress}`);
    }

    let txHash: `0x${string}` | null;
    try {
      txHash = await this.removePoolLiquidity(
        publicClient,
        adapter,
        wallet1,
        wallet1Account,
        wallet1Address,
        tokenAddress,
        poolAddress
      );
    } catch (error) {
      throw new Error(describeError(error));
    }
    if (!txHash) throw new Error(`Wallet 1 holds no LP for pool ${poolAddress}`);

    this.lpRepository.remove(poolAddress);
    for (const job of this.repository.markLpRemovedForPool(poolAddress, txHash)) {
      this.broadcast?.(job, 'updated');
    }

    return { poolAddress, tokenAddress, txHash, success: true };
  }

  private collectPoolCandidates(): Map<Address, PoolCandidateMeta> {
    const candidates = new Map<Address, PoolCandidateMeta>();

    for (const job of this.repository.list()) {
      if (!job.poolAddress) continue;
      const poolAddress = getAddress(job.poolAddress);
      const existing = candidates.get(poolAddress) ?? { jobIds: [], dex: getDexAdapter(job.input.dex).key };
      existing.jobIds.push(job.jobId);
      if (job.tokenAddress) existing.tokenAddress = getAddress(job.tokenAddress);
      if (job.input.tokenName) existing.tokenName = job.input.tokenName;
      if (job.input.tokenSymbol) existing.tokenSymbol = job.input.tokenSymbol;
      existing.dex = getDexAdapter(job.input.dex).key;
      candidates.set(poolAddress, existing);
    }

    return candidates;
  }

  private async resolveTokenFromPool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    adapter: DexAdapter,
    poolAddress: Address
  ): Promise<Address> {
    const token0 = (await client.readContract({
      address: poolAddress,
      abi: adapter.poolAbi,
      functionName: 'token0'
    })) as Address;
    const token1 = (await client.readContract({
      address: poolAddress,
      abi: adapter.poolAbi,
      functionName: 'token1'
    })) as Address;
    const weth = getAddress(adapter.weth);
    if (getAddress(token0) === weth) return getAddress(token1);
    if (getAddress(token1) === weth) return getAddress(token0);
    return getAddress(token0);
  }

  private async removePoolLiquidity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    adapter: DexAdapter,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    tokenAddress: Address,
    poolAddress: Address
  ): Promise<`0x${string}` | null> {
    const lpBalance = await this.readPoolLpBalance(publicClient, adapter, poolAddress, wallet1Address);
    if (lpBalance === null || lpBalance <= 0n) return null;

    // Hard precondition: while the fee token has limits enabled, the pair->router burn transfer
    // reverts ("_transfer:: Trading is not active.") and the router masks it as
    // "UniswapV2: TRANSFER_FAILED". Throws if the limits are on and cannot be lifted.
    await this.liftTokenLimitsForRemoval(publicClient, wallet1, wallet1Account, wallet1Address, tokenAddress);

    if (adapter.supportsClaimFees) {
      await this.claimPoolFees(publicClient, adapter, wallet1, wallet1Account, wallet1Address, poolAddress);
    }

    const allowance = (await withRpcRetry(`LP allowance for ${poolAddress}`, () =>
      publicClient.readContract({
        address: poolAddress,
        abi: adapter.poolAbi,
        functionName: 'allowance',
        args: [wallet1Address, adapter.router]
      })
    )) as bigint;

    if (allowance < lpBalance) {
      const lpApproveGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: poolAddress,
          abi: adapter.poolAbi,
          functionName: 'approve',
          args: [adapter.router, MAX_UINT256]
        },
        80_000n
      );
      const lpApproveHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          address: poolAddress,
          abi: adapter.poolAbi,
          functionName: 'approve',
          args: [adapter.router, MAX_UINT256],
          gas: lpApproveGas,
          nonce
        })
      );
      const lpApproveReceipt = await publicClient.waitForTransactionReceipt({
        hash: lpApproveHash,
        timeout: REMOVE_RECEIPT_TIMEOUT_MS
      });
      if (lpApproveReceipt.status !== 'success') {
        throw new Error(
          receiptFailureMessage(`LP token approval for ${adapter.label} router failed`, lpApproveReceipt, lpApproveHash)
        );
      }
    }

    const removeLiquidityArgs = adapter.removeLiquidityEthArgs({
      token: tokenAddress,
      liquidity: lpBalance,
      amountTokenMin: 0n,
      amountEthMin: 0n,
      to: wallet1Address,
      deadline: deadline()
    });
    // Try plain removeLiquidityETH first; a fee-on-transfer token makes it revert because the
    // pair->router burn transfer is taxed, leaving the router short of the exact amount it forwards.
    // Fall back to the SupportingFeeOnTransferTokens variant, which forwards the router's actual
    // received balance. EVERY candidate is simulated before broadcast — a router revert costs real
    // gas and tells us nothing, so a candidate that cannot succeed is never sent.
    const removeCandidates = ['removeLiquidityETH', adapter.removeLiquiditySupportingFunctionName];
    const simulationFailures: string[] = [];

    for (const functionName of removeCandidates) {
      const request = {
        account: wallet1Address,
        address: adapter.router,
        abi: adapter.routerAbi,
        functionName,
        args: removeLiquidityArgs
      };

      try {
        await publicClient.simulateContract(request);
      } catch (error) {
        simulationFailures.push(`${functionName}: ${describeError(error)}`);
        continue;
      }

      const removeGas = await this.estimateWriteGas(publicClient, request, 600_000n);
      const removeHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({ ...request, account: wallet1Account, chain: BASE_CHAIN, gas: removeGas, nonce })
      );
      const removeReceipt = await publicClient.waitForTransactionReceipt({
        hash: removeHash,
        timeout: REMOVE_RECEIPT_TIMEOUT_MS
      });
      if (removeReceipt.status !== 'success') {
        // Simulated clean but reverted on-chain — state moved under us. Surface the real reason.
        const reason = await this.explainRemoveRevert(publicClient, adapter, tokenAddress, poolAddress);
        throw new Error(receiptFailureMessage(`${functionName} failed${reason ? ` — ${reason}` : ''}`, removeReceipt, removeHash));
      }
      return removeHash;
    }

    // Nothing could succeed and nothing was broadcast. Report every candidate's revert plus the
    // token-level cause hiding behind the router's generic "TRANSFER_FAILED".
    const reason = await this.explainRemoveRevert(publicClient, adapter, tokenAddress, poolAddress);
    throw new Error(
      `Remove liquidity would revert for pool ${poolAddress}` +
        (reason ? ` — ${reason}` : '') +
        ` · tried ${simulationFailures.join(' · ')}`
    );
  }

  /**
   * Explain a remove-liquidity revert in terms of the TOKEN, not the router.
   *
   * The router reports "UniswapV2: TRANSFER_FAILED" for any failed token transfer inside `burn()`,
   * discarding the token's own revert data. Re-run that pair->router transfer standalone to recover
   * the real `require` string, and add the actionable cause when we recognise it.
   */
  private async explainRemoveRevert(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    adapter: DexAdapter,
    tokenAddress: Address,
    poolAddress: Address
  ): Promise<string | undefined> {
    try {
      const pairTokenBalance = (await publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [poolAddress]
      })) as bigint;
      if (pairTokenBalance <= 0n) return undefined;

      const tokenRevert = await probeTokenTransferRevert(
        publicClient,
        tokenAddress,
        poolAddress,
        adapter.router,
        pairTokenBalance
      );
      if (!tokenRevert) return undefined;

      const limitsActive = await this.tokenLimitsActive(publicClient, tokenAddress);
      const hint = limitsActive
        ? ' (token still has limitsEnabled — call removeLimitsNow() from the token owner)'
        : '';
      return `the pair->router transfer reverts in the token: "${tokenRevert}"${hint}`;
    } catch {
      return undefined;
    }
  }

  private async claimPoolFees(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    adapter: DexAdapter,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    poolAddress: Address
  ): Promise<void> {
    try {
      const claimGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: poolAddress,
          abi: adapter.poolAbi,
          functionName: 'claimFees'
        },
        120_000n
      );
      const claimHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          address: poolAddress,
          abi: adapter.poolAbi,
          functionName: 'claimFees',
          gas: claimGas,
          nonce
        })
      );
      const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimHash });
      if (claimReceipt.status !== 'success') {
        console.warn(
          receiptFailureMessage('Claim LP fees transaction failed', claimReceipt, claimHash)
        );
        return;
      }

      await this.unwrapAllWeth(publicClient, adapter, wallet1, wallet1Account, wallet1Address);
    } catch (error) {
      console.warn(`LP fee claim failed for pool ${poolAddress}:`, formatViemError(error));
    }
  }

  /** Unwrap wallet WETH balance to native ETH (Aerodrome fee claims pay out as WETH). */
  private async unwrapAllWeth(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    adapter: DexAdapter,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address
  ): Promise<void> {
    try {
      const wethBalance = (await withRpcRetry('WETH balance', () =>
        publicClient.readContract({
          address: adapter.weth,
          abi: wethAbi,
          functionName: 'balanceOf',
          args: [wallet1Address]
        })
      )) as bigint;
      if (wethBalance <= 0n) return;

      const unwrapGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: adapter.weth,
          abi: wethAbi,
          functionName: 'withdraw',
          args: [wethBalance]
        },
        50_000n
      );
      const unwrapHash = await this.sendTx(wallet1Account, (nonce) =>
        wallet1.writeContract({
          account: wallet1Account,
          chain: BASE_CHAIN,
          address: adapter.weth,
          abi: wethAbi,
          functionName: 'withdraw',
          args: [wethBalance],
          gas: unwrapGas,
          nonce
        })
      );
      const unwrapReceipt = await publicClient.waitForTransactionReceipt({ hash: unwrapHash });
      if (unwrapReceipt.status !== 'success') {
        console.warn(
          receiptFailureMessage('WETH unwrap to ETH failed', unwrapReceipt, unwrapHash)
        );
      }
    } catch (error) {
      console.warn('WETH unwrap to ETH failed:', formatViemError(error));
    }
  }
}

export class TokenLaunchInputParser {
  static parse(body: unknown): TokenLaunchInput {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const dex = TokenLaunchInputParser.parseDex(source.dex);
    const tokenName = str(source.tokenName) || 'AI';
    const tokenSymbol = str(source.tokenSymbol) || tokenName.slice(0, 8).toUpperCase() || 'AI';
    const lpEthAmount = str(source.lpEthAmount) || DEFAULT_LP_ETH;
    const buyEthAmount = str(source.buyEthAmount) || DEFAULT_BUY_ETH;
    const wallet2BuyEthAmount = str(source.wallet2BuyEthAmount) || buyEthAmount;
    const repeatCount = TokenLaunchInputParser.parseRepeatCount(source.repeatCount ?? source.repeat);
    const removeLp = TokenLaunchInputParser.parseRemoveLp(source.removeLp);
    const removeLpTimeMinutes = TokenLaunchInputParser.parseRemoveLpTimeMinutes(
      source.removeLpTimeMinutes ?? source.removeLpTime ?? source.monitorMinutes
    );
    const minBuyersBeforeRemoveLp = TokenLaunchInputParser.parseMinBuyersBeforeRemoveLp(
      source.minBuyersBeforeRemoveLp ?? source.minBuyers
    );
    const useWallet3 = TokenLaunchInputParser.parseUseWallet3(source.useWallet3);
    const buyAfterSeconds = TokenLaunchInputParser.parseBuyAfterSeconds(
      source.buyAfterSeconds ?? source.buyAfterSec ?? source.noBuyerBuySeconds
    );

    if (Number(lpEthAmount) <= 0) throw new Error('lpEthAmount must be greater than 0');
    if (Number(wallet2BuyEthAmount) <= 0) throw new Error('wallet2BuyEthAmount must be greater than 0');
    if (useWallet3 && Number(buyEthAmount) <= 0) {
      throw new Error('buyEthAmount must be greater than 0 when useWallet3 is enabled');
    }

    return {
      dex,
      tokenName,
      tokenSymbol,
      lpEthAmount,
      wallet2BuyEthAmount,
      buyEthAmount,
      useWallet3,
      buyAfterSeconds,
      repeatCount,
      removeLp,
      removeLpTimeMinutes,
      minBuyersBeforeRemoveLp
    };
  }

  private static parseDex(value: unknown): DexKey {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      const match = DEX_ADAPTERS.find((adapter) => adapter.key === normalized);
      if (match) return match.key;
    }
    return DEFAULT_DEX;
  }

  private static parseUseWallet3(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1' || normalized === 'yes';
    }
    return false;
  }

  private static parseBuyAfterSeconds(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number.parseInt(value.trim(), 10)
          : DEFAULT_BUY_AFTER_SECONDS;
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('buyAfterSeconds must be an integer >= 1');
    }
    if (parsed > MAX_BUY_AFTER_SECONDS) {
      throw new Error(`buyAfterSeconds must be at most ${MAX_BUY_AFTER_SECONDS}`);
    }
    return Math.floor(parsed);
  }

  private static parseMinBuyersBeforeRemoveLp(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number.parseInt(value.trim(), 10)
          : DEFAULT_MIN_BUYERS_BEFORE_REMOVE_LP;
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('minBuyersBeforeRemoveLp must be an integer >= 1');
    }
    if (parsed > MAX_MIN_BUYERS_BEFORE_REMOVE_LP) {
      throw new Error(`minBuyersBeforeRemoveLp must be at most ${MAX_MIN_BUYERS_BEFORE_REMOVE_LP}`);
    }
    return Math.floor(parsed);
  }

  private static parseRemoveLpTimeMinutes(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number.parseFloat(value.trim())
          : DEFAULT_REMOVE_LP_TIME_MINUTES;
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('removeLpTimeMinutes must be at least 1');
    }
    const minutes = Math.floor(parsed);
    if (minutes > MAX_REMOVE_LP_TIME_MINUTES) {
      throw new Error(`removeLpTimeMinutes must be at most ${MAX_REMOVE_LP_TIME_MINUTES}`);
    }
    return minutes;
  }

  private static parseRemoveLp(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    }
    return true;
  }

  private static parseRepeatCount(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number.parseInt(value.trim(), 10)
          : 1;
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('repeatCount must be an integer >= 1');
    }
    if (parsed > MAX_REPEAT_COUNT) {
      throw new Error(`repeatCount must be at most ${MAX_REPEAT_COUNT}`);
    }
    return parsed;
  }
}

const DEFAULT_MANUAL_SUPPLY = '1000000000';

export class ManualDeployInputParser {
  static parse(body: unknown): ManualTokenDeployInput {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

    const tokenType = str(source.tokenType).toLowerCase() as TokenDeployType;
    if (tokenType !== 'normal' && tokenType !== 'tax') {
      throw new Error("tokenType must be 'normal' or 'tax'");
    }

    // The tax contract hardcodes its own name/symbol/supply — nothing else to validate.
    if (tokenType === 'tax') return { tokenType };

    const tokenName = str(source.tokenName);
    const tokenSymbol = str(source.tokenSymbol) || tokenName.slice(0, 8).toUpperCase();
    const totalSupply = str(source.totalSupply) || DEFAULT_MANUAL_SUPPLY;
    if (!tokenName) throw new Error('tokenName is required for a normal token');
    if (!tokenSymbol) throw new Error('tokenSymbol is required for a normal token');
    const supply = Number(totalSupply);
    if (!Number.isFinite(supply) || supply <= 0) {
      throw new Error('totalSupply must be a number greater than 0');
    }

    return { tokenType, tokenName, tokenSymbol, totalSupply };
  }
}
