import { parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createBasePublicClient, withRpcRetry } from '../rpc';
import { TokenLaunchInputParser, TokenLaunchService } from '../skills/tokenlaunch';
import { DEFAULT_BUY_ETH, DEFAULT_LP_ETH } from '../skills/tokenlaunch/config';
import { WorkflowRepository, nowIso, toPublicWorkflow } from '../persist';
import { sweepWalletsToExchange } from './sweep';
import type {
  AutomationOrder,
  LaunchWorkflow,
  LaunchWorkflowInput,
  LaunchWorkflowRecord,
  StoredWorkflowWallet,
  TokenLaunchJob,
  TokenLaunchTradesResponse,
  WithdrawRequest
} from '../types';

export type LaunchWorkflowBroadcast = (workflow: LaunchWorkflow, event: 'created' | 'updated') => void;

export type WorkflowOrderCreator = (extensionId: string, input: WithdrawRequest) => Promise<AutomationOrder>;

const WALLET1_GAS_BUFFER = parseEther('0.004');
const WALLET2_GAS_BUFFER = parseEther('0.001');
const WALLET3_GAS_BUFFER = parseEther('0.001');
const BALANCE_TOLERANCE = parseEther('0.001');
const ORDER_POLL_MS = 2_000;
const ORDER_TIMEOUT_MS = 30 * 60 * 1000;
const BALANCE_POLL_MS = 15_000;
const BALANCE_TIMEOUT_MS = 45 * 60 * 1000;
const LAUNCH_POLL_MS = 4_000;
const LAUNCH_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const WITHDRAW_DELAY_MIN_MS = 10_000;
const WITHDRAW_DELAY_MAX_MS = 18_000;
const WITHDRAW_MAX_ATTEMPTS = 3;
const WITHDRAW_RETRY_DELAY_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return prefixed as `0x${string}`;
}

function computeWithdrawAmounts(input: LaunchWorkflowInput): {
  wallet1: string;
  wallet2: string;
  wallet3?: string;
} {
  const launch = input.tokenLaunch;
  const lpEth = parseEther(launch.lpEthAmount || DEFAULT_LP_ETH);
  const wallet2Buy = parseEther(launch.wallet2BuyEthAmount?.trim() || launch.buyEthAmount || DEFAULT_BUY_ETH);
  const wallet3Buy = parseEther(launch.buyEthAmount || DEFAULT_BUY_ETH);

  const wallet1Wei = lpEth + WALLET1_GAS_BUFFER;
  const wallet2Wei = wallet2Buy + WALLET2_GAS_BUFFER;
  const wallet3Wei = wallet3Buy + WALLET3_GAS_BUFFER;

  return {
    wallet1: input.wallet1WithdrawAmount?.trim() || formatEth(wallet1Wei),
    wallet2: input.wallet2WithdrawAmount?.trim() || formatEth(wallet2Wei),
    wallet3:
      input.walletCount === 3
        ? input.wallet3WithdrawAmount?.trim() || formatEth(wallet3Wei)
        : undefined
  };
}

function formatEth(wei: bigint): string {
  const asNumber = Number(wei) / 1e18;
  return asNumber.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function requiredBalanceWei(index: 1 | 2 | 3, input: LaunchWorkflowInput): bigint {
  const amounts = computeWithdrawAmounts(input);
  const amount =
    index === 1 ? amounts.wallet1 : index === 2 ? amounts.wallet2 : amounts.wallet3 || '0';
  return parseEther(amount) - BALANCE_TOLERANCE;
}

function withdrawDelayMs(): number {
  return WITHDRAW_DELAY_MIN_MS + Math.floor(Math.random() * (WITHDRAW_DELAY_MAX_MS - WITHDRAW_DELAY_MIN_MS + 1));
}

export class LaunchWorkflowInputParser {
  static parse(body: unknown): LaunchWorkflowInput {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const opt = (v: unknown) => {
      const t = str(v);
      return t || undefined;
    };

    const extensionId = str(source.extensionId);
    if (!extensionId) throw new Error('extensionId is required');

    const walletCountRaw = source.walletCount ?? source.wallets ?? source.walletCount;
    const walletCount =
      walletCountRaw === 3 || walletCountRaw === '3' ? 3 : walletCountRaw === 2 || walletCountRaw === '2' ? 2 : null;
    if (walletCount === null) throw new Error('walletCount must be 2 or 3');

    const autoStartLaunch = LaunchWorkflowInputParser.parseBool(source.autoStartLaunch, true);
    const analyzeOnComplete = LaunchWorkflowInputParser.parseBool(source.analyzeOnComplete, true);

    const tokenLaunchSource =
      source.tokenLaunch && typeof source.tokenLaunch === 'object'
        ? source.tokenLaunch
        : source;
    const tokenLaunch = TokenLaunchInputParser.parse(tokenLaunchSource);
    if (walletCount === 3) {
      tokenLaunch.useWallet3 = true;
    }

    return {
      extensionId,
      walletCount,
      autoStartLaunch,
      analyzeOnComplete,
      wallet1WithdrawAmount: opt(source.wallet1WithdrawAmount),
      wallet2WithdrawAmount: opt(source.wallet2WithdrawAmount),
      wallet3WithdrawAmount: opt(source.wallet3WithdrawAmount),
      tokenLaunch
    };
  }

  private static parseBool(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined || value === null) return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    }
    return defaultValue;
  }
}

const MANUAL_DEPOSIT_BLOCKING_STATUSES = new Set<LaunchWorkflowRecord['status']>([
  'pending',
  'creating_wallets',
  'withdrawing',
  'waiting_funds',
  'launching',
  'analyzing'
]);

export class LaunchWorkflowService {
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly manualDepositing = new Set<string>();

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly tokenLaunch: TokenLaunchService,
    private readonly createWithdrawOrder: WorkflowOrderCreator,
    private readonly getOrder: (orderId: string) => AutomationOrder | undefined,
    private readonly broadcast?: LaunchWorkflowBroadcast
  ) {}

  list(): LaunchWorkflow[] {
    return this.repository.list();
  }

  get(workflowId: string): LaunchWorkflow | undefined {
    return this.repository.get(workflowId);
  }

  start(input: LaunchWorkflowInput): LaunchWorkflow {
    if (this.repository.findActive()) {
      throw new Error('A launch workflow is already running');
    }
    if (this.tokenLaunch.hasActiveLaunch()) {
      throw new Error('A token launch is already running');
    }

    const workflow = this.repository.create(input);
    const publicWorkflow = toPublicWorkflow(workflow);
    this.broadcast?.(publicWorkflow, 'created');
    void this.run(workflow.workflowId);
    return publicWorkflow;
  }

  async deposit(workflowId: string): Promise<LaunchWorkflow> {
    const record = this.repository.getRecord(workflowId);
    if (!record) throw new Error('Launch workflow not found');
    if (this.manualDepositing.has(workflowId)) {
      throw new Error('Deposit already in progress for this workflow');
    }
    if (this.running.has(workflowId)) {
      throw new Error('Cannot deposit while workflow is still running');
    }
    if (MANUAL_DEPOSIT_BLOCKING_STATUSES.has(record.status)) {
      throw new Error('Cannot deposit while workflow is still running');
    }

    const wallets = record.storedWallets;
    if (!wallets?.length) {
      throw new Error('Workflow has no wallets to deposit from');
    }

    this.manualDepositing.add(workflowId);
    const previousStatus = record.status;
    try {
      this.patch(workflowId, { phase: 'Depositing remaining ETH to exchange (manual)' });
      const txHashes = await this.sweepWallets(workflowId, wallets);
      const phase =
        txHashes.length > 0
          ? `Deposited ETH from ${txHashes.length} wallet sweep(s) to exchange`
          : 'No remaining ETH to deposit';

      return this.patch(workflowId, {
        status: previousStatus === 'depositing' ? 'completed' : previousStatus,
        phase
      });
    } finally {
      this.manualDepositing.delete(workflowId);
    }
  }

  cancel(workflowId: string): LaunchWorkflow {
    const workflow = this.repository.getRecord(workflowId);
    if (!workflow) throw new Error('Launch workflow not found');
    if (!['pending', 'creating_wallets', 'withdrawing', 'waiting_funds', 'launching', 'analyzing', 'depositing'].includes(workflow.status)) {
      throw new Error('Only active workflows can be cancelled');
    }

    this.cancelled.add(workflowId);
    this.tokenLaunch.clearSessionWallets();

    const updated = this.patch(workflowId, {
      status: 'cancelled',
      phase: 'Cancelled by user',
      completedAt: nowIso(),
      error: 'Cancelled by user'
    });
    return updated;
  }

  private patch(workflowId: string, patch: Partial<LaunchWorkflowRecord>): LaunchWorkflow {
    if (this.cancelled.has(workflowId)) {
      const existing = this.repository.get(workflowId);
      if (!existing) throw new Error(`Launch workflow ${workflowId} not found`);
      return existing;
    }
    const updated = this.repository.update(workflowId, patch);
    if (!updated) throw new Error(`Launch workflow ${workflowId} not found`);
    const publicWorkflow = toPublicWorkflow(updated);
    this.broadcast?.(publicWorkflow, 'updated');
    return publicWorkflow;
  }

  private fail(workflowId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.patch(workflowId, {
      status: 'failed',
      error: message,
      phase: 'Failed',
      completedAt: nowIso()
    });
    this.tokenLaunch.clearSessionWallets();
  }

  private generateWallets(count: 2 | 3): StoredWorkflowWallet[] {
    const wallets: StoredWorkflowWallet[] = [];
    for (const index of [1, 2, 3] as const) {
      if (index === 3 && count === 2) break;
      const privateKey = normalizePrivateKey(generatePrivateKey());
      const account = privateKeyToAccount(privateKey);
      wallets.push({ index, address: account.address, privateKey });
    }
    return wallets;
  }

  private async waitForOrder(workflowId: string, orderId: string): Promise<AutomationOrder> {
    const deadline = Date.now() + ORDER_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.cancelled.has(workflowId)) {
        throw new Error('Workflow cancelled');
      }
      const order = this.getOrder(orderId);
      if (order?.status === 'completed') return order;
      if (order?.status === 'cancelled') throw new Error('Withdraw order cancelled');
      if (order?.status === 'failed') throw new Error(order.error || 'Withdraw order failed');
      await sleep(ORDER_POLL_MS);
    }
    throw new Error('Timed out waiting for withdraw order');
  }

  private async waitForBalances(
    workflowId: string,
    wallets: StoredWorkflowWallet[],
    input: LaunchWorkflowInput
  ): Promise<void> {
    const publicClient = createBasePublicClient();
    const deadline = Date.now() + BALANCE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.cancelled.has(workflowId)) throw new Error('Workflow cancelled');

      const pending = await Promise.all(
        wallets.map(async (wallet) => {
          const balance = await withRpcRetry(`balance for wallet ${wallet.index}`, () =>
            publicClient.getBalance({ address: wallet.address as Address })
          );
          const required = requiredBalanceWei(wallet.index, input);
          return balance >= required ? null : wallet.index;
        })
      );

      const waiting = pending.filter((value): value is 1 | 2 | 3 => value !== null);
      if (waiting.length === 0) return;

      this.patch(workflowId, {
        status: 'waiting_funds',
        phase: `Waiting for on-chain funds (wallet${waiting.join(', wallet')})`
      });
      await sleep(BALANCE_POLL_MS);
    }

    throw new Error('Timed out waiting for wallet balances after withdraw');
  }

  private async waitForLaunch(workflowId: string, jobId: string): Promise<TokenLaunchJob> {
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    const active = new Set<TokenLaunchJob['status']>([
      'pending',
      'deploying',
      'adding_liquidity',
      'monitoring',
      'buying',
      'removing_liquidity'
    ]);

    while (Date.now() < deadline) {
      if (this.cancelled.has(workflowId)) throw new Error('Workflow cancelled');
      const job = this.tokenLaunch.get(jobId);
      if (!job) throw new Error('Token launch job not found');
      if (job.status === 'completed') return job;
      if (job.status === 'failed') throw new Error(job.error || 'Token launch failed');
      if (active.has(job.status)) {
        this.patch(workflowId, {
          status: 'launching',
          phase: job.phase || job.status
        });
      }
      await sleep(LAUNCH_POLL_MS);
    }

    throw new Error('Timed out waiting for token launch to finish');
  }

  private async runWithdraws(
    workflowId: string,
    extensionId: string,
    wallets: StoredWorkflowWallet[],
    input: LaunchWorkflowInput
  ): Promise<string[]> {
    const amounts = computeWithdrawAmounts(input);
    const orderIds: string[] = [];

    for (let index = 0; index < wallets.length; index += 1) {
      const wallet = wallets[index];
      if (this.cancelled.has(workflowId)) throw new Error('Workflow cancelled');

      const amount =
        wallet.index === 1 ? amounts.wallet1 : wallet.index === 2 ? amounts.wallet2 : amounts.wallet3;
      if (!amount) throw new Error(`Missing withdraw amount for wallet ${wallet.index}`);

      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= WITHDRAW_MAX_ATTEMPTS; attempt += 1) {
        if (this.cancelled.has(workflowId)) throw new Error('Workflow cancelled');

        this.patch(workflowId, {
          status: 'withdrawing',
          phase:
            attempt === 1
              ? `Withdrawing ${amount} ETH to wallet ${wallet.index} (${index + 1}/${wallets.length})`
              : `Retrying withdraw ${amount} ETH to wallet ${wallet.index} (attempt ${attempt}/${WITHDRAW_MAX_ATTEMPTS})`
        });

        const order = await this.createWithdrawOrder(extensionId, {
          text: `Workflow fund wallet ${wallet.index}`,
          currency: 'ETH',
          chain: 'base',
          address: wallet.address,
          amount
        });
        orderIds.push(order.orderId);
        this.patch(workflowId, { withdrawOrderIds: [...orderIds] });

        try {
          await this.waitForOrder(workflowId, order.orderId);
          lastError = null;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          if (attempt >= WITHDRAW_MAX_ATTEMPTS) {
            throw lastError;
          }
          const delayMs = WITHDRAW_RETRY_DELAY_MS;
          this.patch(workflowId, {
            phase: `Withdraw to wallet ${wallet.index} failed (${lastError.message}) — retrying in ${Math.round(delayMs / 1000)}s`
          });
          await sleep(delayMs);
        }
      }

      if (index < wallets.length - 1) {
        const delayMs = withdrawDelayMs();
        this.patch(workflowId, {
          phase: `Withdraw ${index + 1}/${wallets.length} done — waiting ${Math.round(delayMs / 1000)}s before next`
        });
        await sleep(delayMs);
      }
    }

    return orderIds;
  }

  private async sweepWallets(workflowId: string, wallets: StoredWorkflowWallet[]): Promise<string[]> {
    if (this.cancelled.has(workflowId)) throw new Error('Workflow cancelled');

    const results = await sweepWalletsToExchange(wallets);
    const txHashes = results.flatMap((result) => (result.txHash ? [result.txHash] : []));
    const deposited = results.filter((result) => result.txHash);
    const record = this.repository.getRecord(workflowId);
    const previousHashes = record?.depositTxHashes ?? [];
    const mergedHashes = [...previousHashes, ...txHashes.filter((hash) => !previousHashes.includes(hash))];

    if (deposited.length > 0) {
      this.patch(workflowId, {
        depositTxHashes: mergedHashes,
        phase: `Deposited ETH from ${deposited.length} wallet(s) to exchange`
      });
    } else {
      this.patch(workflowId, { phase: 'No remaining ETH to deposit' });
    }

    return txHashes;
  }

  private async depositToExchange(workflowId: string, wallets: StoredWorkflowWallet[]): Promise<string[]> {
    this.patch(workflowId, {
      status: 'depositing',
      phase: 'Depositing remaining ETH to exchange'
    });
    return this.sweepWallets(workflowId, wallets);
  }

  private async finishWorkflow(
    workflowId: string,
    wallets: StoredWorkflowWallet[],
    patch: Partial<LaunchWorkflowRecord>
  ): Promise<void> {
    await this.depositToExchange(workflowId, wallets);
    this.patch(workflowId, {
      ...patch,
      status: 'completed',
      completedAt: nowIso()
    });
  }

  private async run(workflowId: string): Promise<void> {
    if (this.running.has(workflowId)) return;
    this.running.add(workflowId);

    try {
      const record = this.repository.getRecord(workflowId);
      if (!record) return;
      const input = record.input;

      this.patch(workflowId, { status: 'creating_wallets', phase: 'Generating wallets' });
      const wallets = this.generateWallets(input.walletCount);
      this.repository.setWallets(workflowId, wallets);

      const orderIds = await this.runWithdraws(workflowId, input.extensionId, wallets, input);
      this.patch(workflowId, { withdrawOrderIds: orderIds, status: 'waiting_funds', phase: 'Confirming on-chain balances' });
      await this.waitForBalances(workflowId, wallets, input);

      if (!input.autoStartLaunch) {
        await this.finishWorkflow(workflowId, wallets, {
          phase: 'Wallets funded — start token launch manually'
        });
        return;
      }

      const wallet1 = wallets.find((wallet) => wallet.index === 1);
      const wallet2 = wallets.find((wallet) => wallet.index === 2);
      const wallet3 = wallets.find((wallet) => wallet.index === 3);
      if (!wallet1 || !wallet2) throw new Error('Workflow wallets missing');

      this.tokenLaunch.useSessionWallets({
        wallet1: wallet1.privateKey,
        wallet2: wallet2.privateKey,
        wallet3: wallet3?.privateKey
      });

      this.patch(workflowId, { status: 'launching', phase: 'Starting token launch' });
      const launchInput = { ...input.tokenLaunch, useWallet3: input.walletCount === 3 };
      const job = this.tokenLaunch.start(launchInput);
      this.patch(workflowId, { launchJobId: job.jobId, phase: job.phase || 'Launch started' });

      const finishedJob = await this.waitForLaunch(workflowId, job.jobId);

      if (input.analyzeOnComplete && finishedJob.tokenAddress && finishedJob.poolAddress) {
        this.patch(workflowId, { status: 'analyzing', phase: 'Syncing launch trades' });
        const analysis = await this.tokenLaunch.getTrades(job.jobId, true);
        await this.finishWorkflow(workflowId, wallets, {
          phase: 'Completed — analysis ready',
          analysis
        });
      } else {
        await this.finishWorkflow(workflowId, wallets, { phase: 'Completed' });
      }
    } catch (error) {
      if (!this.cancelled.has(workflowId)) {
        this.fail(workflowId, error);
      }
    } finally {
      this.tokenLaunch.clearSessionWallets();
      this.running.delete(workflowId);
      this.cancelled.delete(workflowId);
    }
  }
}
