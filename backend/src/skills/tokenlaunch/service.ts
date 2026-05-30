import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  getAddress,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type TransactionReceipt,
  type WalletClient
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TokenLaunchInput, TokenLaunchJob, LpRemovalResult, UnremovedLpPosition } from '../../types';
import { TokenLaunchRepository, nowIso } from '../../persist';
import {
  AERODROME,
  BASE_CHAIN,
  DEFAULT_BUY_ETH,
  DEFAULT_LP_ETH,
  DEFAULT_MIN_BUYERS_BEFORE_REMOVE_LP,
  DEFAULT_REMOVE_LP_TIME_MINUTES,
  DEFAULT_TOKEN_SUPPLY,
  MAX_MIN_BUYERS_BEFORE_REMOVE_LP,
  MAX_REMOVE_LP_TIME_MINUTES,
  DEFAULT_BUY_AFTER_SECONDS,
  MAX_BUY_AFTER_SECONDS,
  SWAP_POLL_MS,
  aerodromeFactoryAbi,
  aerodromePoolAbi,
  aerodromeRouterAbi
} from './config';
import { launchTokenAbi, launchTokenBytecode } from './contracts';

export type TokenLaunchBroadcast = (job: TokenLaunchJob, event: 'created' | 'updated') => void;

const MAX_REPEAT_COUNT = 50;
const LP_SCAN_DELAY_MS = 800;

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

export class TokenLaunchService {
  private readonly running = new Set<string>();
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

  constructor(
    private readonly repository: TokenLaunchRepository,
    private readonly broadcast?: TokenLaunchBroadcast
  ) {}

  isConfigured(): boolean {
    return Boolean(
      process.env.WALLET_1_PRIVATE_KEY?.trim() &&
        process.env.WALLET_2_PRIVATE_KEY?.trim() &&
        (process.env.BASE_RPC_URL?.trim() || true)
    );
  }

  getStatus(): {
    configured: boolean;
    wallet1Address?: string;
    wallet2Address?: string;
    wallet3Address?: string;
    wallet3Configured: boolean;
    rpcUrl: string;
  } {
    const rpcUrl = process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';
    const wallet1Key = process.env.WALLET_1_PRIVATE_KEY?.trim();
    const wallet2Key = process.env.WALLET_2_PRIVATE_KEY?.trim();
    const wallet3Key = process.env.WALLET_3_PRIVATE_KEY?.trim();
    if (!wallet1Key || !wallet2Key) {
      return { configured: false, wallet3Configured: Boolean(wallet3Key), rpcUrl };
    }

    try {
      this.ensureClients();
    } catch {
      return { configured: false, wallet3Configured: Boolean(wallet3Key), rpcUrl };
    }

    return {
      configured: true,
      wallet1Address: this.wallet1Address ?? undefined,
      wallet2Address: this.wallet2Address ?? undefined,
      wallet3Address: this.wallet3Address ?? undefined,
      wallet3Configured: Boolean(wallet3Key),
      rpcUrl
    };
  }

  private jobUsesWallet3(input: TokenLaunchInput): boolean {
    return resolveUseWallet3(input) && this.wallet3 !== null;
  }

  private validateLaunchInput(input: TokenLaunchInput): void {
    if (resolveUseWallet3(input) && !process.env.WALLET_3_PRIVATE_KEY?.trim()) {
      throw new Error('useWallet3 requires WALLET_3_PRIVATE_KEY in backend/.env');
    }
  }

  list(): TokenLaunchJob[] {
    return this.repository.list();
  }

  get(jobId: string): TokenLaunchJob | undefined {
    return this.repository.get(jobId);
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

    this.repeatRemaining = 0;
    this.repeatInput = null;
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

      const tokenAddress = getAddress(job.tokenAddress);
      const txHash = await this.swapEthForToken(wallet, tokenAddress, amount);
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

  private scheduleNextRepeat(): void {
    if (this.repeatRemaining <= 1) {
      this.repeatRemaining = 0;
      this.repeatInput = null;
      return;
    }

    this.repeatRemaining -= 1;
    try {
      this.startNextRepeat();
    } catch (error) {
      this.repeatRemaining = 0;
      this.repeatInput = null;
      console.error('Failed to start next token launch repeat:', formatViemError(error));
    }
  }

  private ensureClients(): void {
    const wallet3Key = process.env.WALLET_3_PRIVATE_KEY?.trim();
    const wallet3Ready = Boolean(wallet3Key && this.wallet3 && this.wallet3Account);
    if (this.publicClient && this.wallet1 && this.wallet2 && this.wallet1Account && this.wallet2Account) {
      if (!wallet3Key || wallet3Ready) return;
    }

    const wallet1Key = process.env.WALLET_1_PRIVATE_KEY?.trim();
    const wallet2Key = process.env.WALLET_2_PRIVATE_KEY?.trim();
    if (!wallet1Key || !wallet2Key) {
      throw new Error('WALLET_1_PRIVATE_KEY and WALLET_2_PRIVATE_KEY must be set in backend/.env');
    }

    const rpcUrl = process.env.BASE_RPC_URL?.trim() || 'https://mainnet.base.org';
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
    tokenName: string,
    tokenSymbol: string,
    lpEthAmount: string
  ): Promise<void> {
    const balance = await publicClient.getBalance({ address: wallet1Address });
    const deployData = encodeDeployData({
      abi: launchTokenAbi,
      bytecode: launchTokenBytecode,
      args: [tokenName, tokenSymbol, DEFAULT_TOKEN_SUPPLY]
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
    const postDeployGas = 1_200_000n * gasPrice;
    const required = deployCost + lpEth + postDeployGas;

    if (balance < required) {
      throw new Error(
        `Wallet 1 needs at least ${(Number(required) / 1e18).toFixed(6)} ETH on Base ` +
          `(${lpEthAmount} ETH LP + deploy/post-deploy gas; balance ${(Number(balance) / 1e18).toFixed(6)} ETH)`
      );
    }
  }

  private async swapEthForToken(wallet: 2 | 3, tokenAddress: Address, buyEth: bigint): Promise<`0x${string}`> {
    const publicClient = this.publicClient!;
    if (wallet === 3 && !this.wallet3) {
      throw new Error('Wallet 3 is not configured (set WALLET_3_PRIVATE_KEY in backend/.env)');
    }
    const walletClient = wallet === 2 ? this.wallet2! : this.wallet3!;
    const account = wallet === 2 ? this.wallet2Account! : this.wallet3Account!;
    const recipient = wallet === 2 ? this.wallet2Address! : this.wallet3Address!;
    const route = [{ from: AERODROME.weth, to: tokenAddress, stable: false, factory: AERODROME.factory }] as const;
    const swapArgs = [0n, route, recipient, deadline()] as const;

    const buyGas = await this.estimateWriteGas(
      publicClient,
      {
        account: recipient,
        address: AERODROME.router,
        abi: aerodromeRouterAbi,
        functionName: 'swapExactETHForTokens',
        args: swapArgs,
        value: buyEth
      },
      350_000n
    );
    const buyHash = await walletClient.writeContract({
      account,
      chain: BASE_CHAIN,
      address: AERODROME.router,
      abi: aerodromeRouterAbi,
      functionName: 'swapExactETHForTokens',
      args: swapArgs,
      value: buyEth,
      gas: buyGas
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: buyHash });
    if (receipt.status !== 'success') {
      throw new Error(receiptFailureMessage(`Wallet ${wallet} buy failed`, receipt, buyHash));
    }
    return buyHash;
  }

  private async estimateWriteGas(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    request: Parameters<typeof publicClient.estimateContractGas>[0],
    floor: bigint
  ): Promise<bigint> {
    try {
      const estimate = await publicClient.estimateContractGas(request);
      return gasWithBuffer(estimate, floor);
    } catch {
      return floor;
    }
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

      this.patch(jobId, { status: 'deploying', phase: 'Deploying token' });

      const tokenAmount = DEFAULT_TOKEN_SUPPLY / 2n;
      const wallet1Account = this.wallet1Account!;

      await this.ensureDeployReady(
        publicClient,
        wallet1Address,
        job.input.tokenName,
        job.input.tokenSymbol,
        job.input.lpEthAmount
      );

      const deployHash = await wallet1.deployContract({
        account: wallet1Account,
        chain: BASE_CHAIN,
        abi: launchTokenAbi,
        bytecode: launchTokenBytecode,
        args: [job.input.tokenName, job.input.tokenSymbol, DEFAULT_TOKEN_SUPPLY]
      });

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
        status: 'adding_liquidity',
        phase: 'Creating Aerodrome LP'
      });

      const approveGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: tokenAddress,
          abi: launchTokenAbi,
          functionName: 'approve',
          args: [AERODROME.router, tokenAmount]
        },
        80_000n
      );
      const approveHash = await wallet1.writeContract({
        account: wallet1Account,
        chain: BASE_CHAIN,
        address: tokenAddress,
        abi: launchTokenAbi,
        functionName: 'approve',
        args: [AERODROME.router, tokenAmount],
        gas: approveGas
      });
      const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      if (approveReceipt.status !== 'success') {
        throw new Error(receiptFailureMessage('Token approval for Aerodrome router failed', approveReceipt, approveHash));
      }

      const lpEth = parseEther(job.input.lpEthAmount);
      const addLiquidityGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: AERODROME.router,
          abi: aerodromeRouterAbi,
          functionName: 'addLiquidityETH',
          args: [tokenAddress, false, tokenAmount, 0n, 0n, wallet1Address, deadline()],
          value: lpEth
        },
        1_200_000n
      );
      const addLiquidityHash = await wallet1.writeContract({
        account: wallet1Account,
        chain: BASE_CHAIN,
        address: AERODROME.router,
        abi: aerodromeRouterAbi,
        functionName: 'addLiquidityETH',
        args: [tokenAddress, false, tokenAmount, 0n, 0n, wallet1Address, deadline()],
        value: lpEth,
        gas: addLiquidityGas
      });
      const addLiquidityReceipt = await publicClient.waitForTransactionReceipt({ hash: addLiquidityHash });
      if (addLiquidityReceipt.status !== 'success') {
        throw new Error(receiptFailureMessage('Add liquidity transaction failed', addLiquidityReceipt, addLiquidityHash));
      }

      const poolAddress = await this.resolvePoolAddress(publicClient, tokenAddress, addLiquidityReceipt);

      const monitorStartedAt = Date.now();
      this.patch(jobId, {
        poolAddress,
        addLiquidityTxHash: addLiquidityHash,
        status: 'monitoring',
        phase: 'Monitoring buyers'
      });

      let buyerCount = 0;
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
      const ourWallets = new Set([wallet1Address.toLowerCase(), wallet2Address.toLowerCase()]);
      if (useWallet3 && this.wallet3Address) {
        ourWallets.add(this.wallet3Address.toLowerCase());
      }
      const wallet2BuyEth = resolveWallet2BuyEthAmount(job.input);

      const buyerThresholdMet = (count: number) => count >= minBuyersBeforeRemoveLp;
      const buyerMonitorPhase = (count: number) =>
        minBuyersBeforeRemoveLp > 1
          ? `Monitoring buyers (${count}/${minBuyersBeforeRemoveLp} for early exit)`
          : `Monitoring buyers (${count} detected)`;

      const removeLiquidity = async (reason: string): Promise<void> => {
        if (lpRemoved) return;
        this.patch(jobId, { status: 'removing_liquidity', phase: reason });

        const removeHash = await this.removePoolLiquidity(
          publicClient,
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
        const buyers = await this.countExternalBuyers(
          publicClient,
          poolAddress,
          tokenAddress,
          monitorStartedAt,
          ourWallets
        );
        buyerCount = buyers;
        this.patch(jobId, { buyerCount, phase: buyerMonitorPhase(buyerCount) });

        if (buyerThresholdMet(buyerCount)) {
          if (shouldRemoveLp) {
            await removeLiquidity(
              minBuyersBeforeRemoveLp > 1
                ? `Removing LP after ${buyerCount} buyers (min ${minBuyersBeforeRemoveLp})`
                : 'Removing LP after buyer detected'
            );
            this.patch(jobId, {
              status: 'completed',
              lpRemoved: true,
              buyerCount,
              phase:
                minBuyersBeforeRemoveLp > 1
                  ? `Completed — LP removed after ${buyerCount} buyers`
                  : 'Completed — LP removed after buyer',
              completedAt: nowIso()
            });
          } else {
            this.patch(jobId, {
              status: 'completed',
              buyerCount,
              phase:
                minBuyersBeforeRemoveLp > 1
                  ? `Completed — ${buyerCount} buyers, LP kept (remove manually)`
                  : 'Completed — buyer detected, LP kept (remove manually)',
              completedAt: nowIso()
            });
          }
          return;
        }

        if (!wallet2BuyExecuted && buyerCount === 0 && elapsed >= buyAfterMs) {
          const buyLabel = useWallet3 ? 'wallets 2 & 3' : 'wallet 2';
          this.patch(jobId, { status: 'buying', phase: `No buyers — buying with ${buyLabel}` });
          const buy2Hash = await this.swapEthForToken(2, tokenAddress, parseEther(wallet2BuyEth));
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
            const buy3Hash = await this.swapEthForToken(3, tokenAddress, parseEther(job.input.buyEthAmount));
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
      this.scheduleNextRepeat();
    }
  }

  private poolFromReceipt(receipt: TransactionReceipt, tokenAddress: Address): Address | null {
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(AERODROME.factory)) continue;
      try {
        const decoded = decodeEventLog({
          abi: aerodromeFactoryAbi,
          data: log.data,
          topics: log.topics
        });
        if (decoded.eventName !== 'PoolCreated') continue;
        const { pool, token0, token1 } = decoded.args as {
          pool: Address;
          token0: Address;
          token1: Address;
        };
        const token = getAddress(tokenAddress);
        if (getAddress(token0) === token || getAddress(token1) === token) {
          return getAddress(pool);
        }
      } catch {
        // Not a PoolCreated log for this ABI decode attempt.
      }
    }
    return null;
  }

  private async readPoolAddress(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    tokenAddress: Address
  ): Promise<Address | null> {
    for (const [tokenA, tokenB] of [
      [AERODROME.weth, tokenAddress],
      [tokenAddress, AERODROME.weth]
    ] as const) {
      const pool = (await client.readContract({
        address: AERODROME.factory,
        abi: aerodromeFactoryAbi,
        functionName: 'getPool',
        args: [tokenA, tokenB, false]
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
    tokenAddress: Address,
    receipt?: TransactionReceipt
  ): Promise<Address> {
    if (receipt) {
      const fromReceipt = this.poolFromReceipt(receipt, tokenAddress);
      if (fromReceipt) return fromReceipt;
    }

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const pool = await this.readPoolAddress(client, tokenAddress);
      if (pool) return pool;
      await sleep(500);
    }

    throw new Error('Aerodrome pool was not created');
  }

  private async countExternalBuyers(
    client: { readContract: (...args: unknown[]) => Promise<unknown>; getLogs: (...args: unknown[]) => Promise<unknown[]> },
    poolAddress: Address,
    tokenAddress: Address,
    sinceMs: number,
    ourWallets: Set<string>
  ): Promise<number> {
    const token0 = (await client.readContract({
      address: poolAddress,
      abi: aerodromePoolAbi,
      functionName: 'token0'
    })) as Address;
    const tokenIs0 = getAddress(token0) === getAddress(tokenAddress);
    const sinceBlock = await this.blockNearTimestamp(this.publicClient, sinceMs);
    const logs = (await client.getLogs({
      address: poolAddress,
      event: aerodromePoolAbi[0],
      fromBlock: sinceBlock
    })) as Array<{ data: `0x${string}`; topics: [] | [`0x${string}`, ...`0x${string}`[]] }>;

    const buyers = new Set<string>();
    for (const log of logs) {
      const decoded = decodeEventLog({
        abi: aerodromePoolAbi,
        data: log.data,
        topics: log.topics
      });
      if (decoded.eventName !== 'Swap') continue;

      const { sender, to, amount0In, amount1In, amount0Out, amount1Out } = decoded.args as {
        sender: Address;
        to: Address;
        amount0In: bigint;
        amount1In: bigint;
        amount0Out: bigint;
        amount1Out: bigint;
      };

      const boughtToken = tokenIs0 ? amount0Out > 0n && amount1In > 0n : amount1Out > 0n && amount0In > 0n;
      if (!boughtToken) continue;

      for (const participant of [sender, to]) {
        if (!ourWallets.has(participant.toLowerCase())) {
          buyers.add(participant.toLowerCase());
        }
      }
    }

    return buyers.size;
  }

  private async blockNearTimestamp(client: { getBlockNumber: () => Promise<bigint>; getBlock: (args: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> } | null, timestampMs: number): Promise<bigint> {
    if (!client) return 0n;
    const latest = await client.getBlockNumber();
    const latestBlock = await client.getBlock({ blockNumber: latest });
    const latestTs = Number(latestBlock.timestamp) * 1000;
    if (timestampMs >= latestTs) return latest;

    const secondsAgo = Math.max(0, Math.floor((latestTs - timestampMs) / 1000));
    const estimatedBlocks = BigInt(Math.min(Number(latest), Math.max(1, Math.ceil(secondsAgo / 2))));
    return latest > estimatedBlocks ? latest - estimatedBlocks : 0n;
  }

  async listUnremovedLp(): Promise<UnremovedLpPosition[]> {
    this.ensureClients();
    const publicClient = this.publicClient!;
    const wallet1Address = this.wallet1Address!;
    const candidates = this.collectPoolCandidates();
    const positions: UnremovedLpPosition[] = [];

    for (const [poolAddress, meta] of candidates) {
      await sleep(LP_SCAN_DELAY_MS);
      const lpBalance = await withRpcRetry(`LP balance for ${poolAddress}`, () =>
        publicClient.readContract({
          address: poolAddress,
          abi: aerodromePoolAbi,
          functionName: 'balanceOf',
          args: [wallet1Address]
        })
      ) as bigint;
      if (lpBalance <= 0n) continue;

      const tokenAddress = meta.tokenAddress ?? (await this.resolveTokenFromPool(publicClient, poolAddress));
      positions.push({
        poolAddress,
        tokenAddress,
        lpBalance: lpBalance.toString(),
        jobIds: meta.jobIds,
        tokenName: meta.tokenName,
        tokenSymbol: meta.tokenSymbol
      });
    }

    return positions;
  }

  async removeUnremovedLp(options: { poolAddress?: string; all?: boolean }): Promise<LpRemovalResult[]> {
    this.ensureClients();

    const positions = await this.listUnremovedLp();
    let targets = positions;
    if (options.poolAddress) {
      const wanted = getAddress(options.poolAddress);
      targets = positions.filter((position) => getAddress(position.poolAddress) === wanted);
      if (targets.length === 0) {
        throw new Error('No LP balance found for that pool on wallet 1');
      }
    } else if (!options.all) {
      throw new Error('Provide poolAddress or set all=true');
    } else if (targets.length === 0) {
      return [];
    }

    const publicClient = this.publicClient!;
    const wallet1 = this.wallet1!;
    const wallet1Account = this.wallet1Account!;
    const wallet1Address = this.wallet1Address!;
    const results: LpRemovalResult[] = [];

    for (const position of targets) {
      const poolAddress = getAddress(position.poolAddress);
      const tokenAddress = getAddress(position.tokenAddress);
      try {
        const txHash = await this.removePoolLiquidity(
          publicClient,
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

  private collectPoolCandidates(): Map<
    Address,
    { tokenAddress?: Address; jobIds: string[]; tokenName?: string; tokenSymbol?: string }
  > {
    const candidates = new Map<
      Address,
      { tokenAddress?: Address; jobIds: string[]; tokenName?: string; tokenSymbol?: string }
    >();

    for (const job of this.repository.list()) {
      if (!job.poolAddress) continue;
      const poolAddress = getAddress(job.poolAddress);
      const existing = candidates.get(poolAddress) ?? { jobIds: [] };
      existing.jobIds.push(job.jobId);
      if (job.tokenAddress) existing.tokenAddress = getAddress(job.tokenAddress);
      if (job.input.tokenName) existing.tokenName = job.input.tokenName;
      if (job.input.tokenSymbol) existing.tokenSymbol = job.input.tokenSymbol;
      candidates.set(poolAddress, existing);
    }

    return candidates;
  }

  private async resolveTokenFromPool(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any,
    poolAddress: Address
  ): Promise<Address> {
    const token0 = (await client.readContract({
      address: poolAddress,
      abi: aerodromePoolAbi,
      functionName: 'token0'
    })) as Address;
    const token1 = (await client.readContract({
      address: poolAddress,
      abi: aerodromePoolAbi,
      functionName: 'token1'
    })) as Address;
    const weth = getAddress(AERODROME.weth);
    if (getAddress(token0) === weth) return getAddress(token1);
    if (getAddress(token1) === weth) return getAddress(token0);
    return getAddress(token0);
  }

  private async removePoolLiquidity(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: any,
    wallet1: WalletClient,
    wallet1Account: NonNullable<TokenLaunchService['wallet1Account']>,
    wallet1Address: Address,
    tokenAddress: Address,
    poolAddress: Address
  ): Promise<`0x${string}` | null> {
    const lpBalance = (await withRpcRetry(`LP balance for ${poolAddress}`, () =>
      publicClient.readContract({
        address: poolAddress,
        abi: aerodromePoolAbi,
        functionName: 'balanceOf',
        args: [wallet1Address]
      })
    )) as bigint;
    if (lpBalance <= 0n) return null;

    const allowance = (await withRpcRetry(`LP allowance for ${poolAddress}`, () =>
      publicClient.readContract({
        address: poolAddress,
        abi: aerodromePoolAbi,
        functionName: 'allowance',
        args: [wallet1Address, AERODROME.router]
      })
    )) as bigint;

    if (allowance < lpBalance) {
      const lpApproveGas = await this.estimateWriteGas(
        publicClient,
        {
          account: wallet1Address,
          address: poolAddress,
          abi: aerodromePoolAbi,
          functionName: 'approve',
          args: [AERODROME.router, MAX_UINT256]
        },
        80_000n
      );
      const lpApproveHash = await wallet1.writeContract({
        account: wallet1Account,
        chain: BASE_CHAIN,
        address: poolAddress,
        abi: aerodromePoolAbi,
        functionName: 'approve',
        args: [AERODROME.router, MAX_UINT256],
        gas: lpApproveGas
      });
      const lpApproveReceipt = await publicClient.waitForTransactionReceipt({ hash: lpApproveHash });
      if (lpApproveReceipt.status !== 'success') {
        throw new Error(
          receiptFailureMessage('LP token approval for Aerodrome router failed', lpApproveReceipt, lpApproveHash)
        );
      }
    }

    const removeLiquidityGas = await this.estimateWriteGas(
      publicClient,
      {
        account: wallet1Address,
        address: AERODROME.router,
        abi: aerodromeRouterAbi,
        functionName: 'removeLiquidityETH',
        args: [tokenAddress, false, lpBalance, 0n, 0n, wallet1Address, deadline()]
      },
      600_000n
    );
    const removeHash = await wallet1.writeContract({
      account: wallet1Account,
      chain: BASE_CHAIN,
      address: AERODROME.router,
      abi: aerodromeRouterAbi,
      functionName: 'removeLiquidityETH',
      args: [tokenAddress, false, lpBalance, 0n, 0n, wallet1Address, deadline()],
      gas: removeLiquidityGas
    });
    const removeReceipt = await publicClient.waitForTransactionReceipt({ hash: removeHash });
    if (removeReceipt.status !== 'success') {
      throw new Error(receiptFailureMessage('Remove liquidity transaction failed', removeReceipt, removeHash));
    }

    return removeHash;
  }
}

export class TokenLaunchInputParser {
  static parse(body: unknown): TokenLaunchInput {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
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
