import { randomUUID } from 'crypto';
import { getOrdersDb, getTokenLaunchesDb, getWorkflowsDb, getVerificationDb, getGmailDb, type AppDatabase } from './db';
import type {
  AutomationOrder,
  CachedGmailMessage,
  GmailAccount,
  LaunchWorkflow,
  LaunchWorkflowInput,
  LaunchWorkflowRecord,
  LaunchWorkflowStatus,
  StoredWorkflowWallet,
  TokenLaunchJob,
  TokenLaunchInput,
  UsedGmailMessage,
  VerificationCodeRequest,
  WithdrawRequest
} from './types';

export const GMAIL_RECENT_LIMIT = 5;
export const ORDER_TIMEOUT_MS = 5 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}

function orderStartedAtMs(order: AutomationOrder): number {
  return new Date(order.executingAt ?? order.createdAt).getTime();
}

function sortMessages(messages: CachedGmailMessage[]): CachedGmailMessage[] {
  return [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, GMAIL_RECENT_LIMIT);
}

type OrderRow = {
  order_id: string;
  extension_id: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  executing_at: string | null;
  execute_time_ms: number | null;
};

function rowToOrder(row: OrderRow): AutomationOrder {
  return {
    orderId: row.order_id,
    extensionId: row.extension_id,
    status: row.status as AutomationOrder['status'],
    input: JSON.parse(row.input_json),
    output: row.output_json ? JSON.parse(row.output_json) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executingAt: row.executing_at ?? undefined,
    executeTimeMs: row.execute_time_ms ?? undefined
  };
}

function orderToRow(order: AutomationOrder) {
  return {
    orderId: order.orderId,
    extensionId: order.extensionId,
    status: order.status,
    inputJson: JSON.stringify(order.input),
    outputJson: order.output ? JSON.stringify(order.output) : null,
    error: order.error ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    executingAt: order.executingAt ?? null,
    executeTimeMs: order.executeTimeMs ?? null
  };
}

type TokenLaunchRow = {
  job_id: string;
  status: string;
  input_json: string;
  repeat_index: number | null;
  repeat_total: number | null;
  token_address: string | null;
  pool_address: string | null;
  deploy_block_number: number | null;
  trades_json: string | null;
  trades_synced_at: string | null;
  deploy_tx_hash: string | null;
  add_liquidity_tx_hash: string | null;
  buy_tx_hash: string | null;
  wallet3_buy_tx_hash: string | null;
  wallet1_buy_tx_hash: string | null;
  remove_liquidity_tx_hash: string | null;
  buyer_count: number;
  lp_removed: number;
  wallet2_buy_executed: number;
  wallet3_buy_executed: number | null;
  phase: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function rowToTokenLaunch(row: TokenLaunchRow): TokenLaunchJob {
  return {
    jobId: row.job_id,
    status: row.status as TokenLaunchJob['status'],
    input: JSON.parse(row.input_json),
    repeatIndex: row.repeat_index ?? undefined,
    repeatTotal: row.repeat_total ?? undefined,
    tokenAddress: row.token_address ?? undefined,
    poolAddress: row.pool_address ?? undefined,
    deployBlockNumber: row.deploy_block_number ?? undefined,
    trades: row.trades_json ? JSON.parse(row.trades_json) : undefined,
    tradesSyncedAt: row.trades_synced_at ?? undefined,
    deployTxHash: row.deploy_tx_hash ?? undefined,
    addLiquidityTxHash: row.add_liquidity_tx_hash ?? undefined,
    buyTxHash: row.buy_tx_hash ?? undefined,
    wallet3BuyTxHash: row.wallet3_buy_tx_hash ?? undefined,
    wallet1BuyTxHash: row.wallet1_buy_tx_hash ?? undefined,
    removeLiquidityTxHash: row.remove_liquidity_tx_hash ?? undefined,
    buyerCount: row.buyer_count,
    lpRemoved: row.lp_removed === 1,
    wallet2BuyExecuted: row.wallet2_buy_executed === 1,
    wallet3BuyExecuted: row.wallet3_buy_executed == null ? undefined : row.wallet3_buy_executed === 1,
    phase: row.phase ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  };
}

function tokenLaunchToRow(job: TokenLaunchJob) {
  return {
    jobId: job.jobId,
    status: job.status,
    inputJson: JSON.stringify(job.input),
    repeatIndex: job.repeatIndex ?? null,
    repeatTotal: job.repeatTotal ?? null,
    tokenAddress: job.tokenAddress ?? null,
    poolAddress: job.poolAddress ?? null,
    deployBlockNumber: job.deployBlockNumber ?? null,
    tradesJson: job.trades ? JSON.stringify(job.trades) : null,
    tradesSyncedAt: job.tradesSyncedAt ?? null,
    deployTxHash: job.deployTxHash ?? null,
    addLiquidityTxHash: job.addLiquidityTxHash ?? null,
    buyTxHash: job.buyTxHash ?? null,
    wallet3BuyTxHash: job.wallet3BuyTxHash ?? null,
    wallet1BuyTxHash: job.wallet1BuyTxHash ?? null,
    removeLiquidityTxHash: job.removeLiquidityTxHash ?? null,
    buyerCount: job.buyerCount ?? 0,
    lpRemoved: job.lpRemoved ? 1 : 0,
    wallet2BuyExecuted: job.wallet2BuyExecuted ? 1 : 0,
    wallet3BuyExecuted: job.wallet3BuyExecuted == null ? null : job.wallet3BuyExecuted ? 1 : 0,
    phase: job.phase ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null
  };
}

type WorkflowRow = {
  workflow_id: string;
  status: string;
  phase: string | null;
  input_json: string;
  wallets_json: string | null;
  stored_wallets_json: string | null;
  withdraw_order_ids_json: string | null;
  launch_job_id: string | null;
  deposit_tx_hashes_json: string | null;
  analysis_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function rowToWorkflow(row: WorkflowRow): LaunchWorkflowRecord {
  return {
    workflowId: row.workflow_id,
    status: row.status as LaunchWorkflowStatus,
    phase: row.phase ?? undefined,
    input: JSON.parse(row.input_json),
    wallets: row.wallets_json ? JSON.parse(row.wallets_json) : undefined,
    storedWallets: row.stored_wallets_json ? JSON.parse(row.stored_wallets_json) : undefined,
    withdrawOrderIds: row.withdraw_order_ids_json ? JSON.parse(row.withdraw_order_ids_json) : undefined,
    launchJobId: row.launch_job_id ?? undefined,
    depositTxHashes: row.deposit_tx_hashes_json ? JSON.parse(row.deposit_tx_hashes_json) : undefined,
    analysis: row.analysis_json ? JSON.parse(row.analysis_json) : undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  };
}

function workflowToRow(workflow: LaunchWorkflowRecord) {
  return {
    workflowId: workflow.workflowId,
    status: workflow.status,
    phase: workflow.phase ?? null,
    inputJson: JSON.stringify(workflow.input),
    walletsJson: workflow.wallets ? JSON.stringify(workflow.wallets) : null,
    storedWalletsJson: workflow.storedWallets ? JSON.stringify(workflow.storedWallets) : null,
    withdrawOrderIdsJson: workflow.withdrawOrderIds ? JSON.stringify(workflow.withdrawOrderIds) : null,
    launchJobId: workflow.launchJobId ?? null,
    depositTxHashesJson: workflow.depositTxHashes ? JSON.stringify(workflow.depositTxHashes) : null,
    analysisJson: workflow.analysis ? JSON.stringify(workflow.analysis) : null,
    error: workflow.error ?? null,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    completedAt: workflow.completedAt ?? null
  };
}

type VerificationRow = {
  request_id: string;
  order_id: string;
  extension_id: string;
  email_code_sent_at: number;
  status: string;
  email_code: string | null;
  gmail_account_id: string | null;
  gmail_message_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function rowToVerification(row: VerificationRow): VerificationCodeRequest {
  return {
    requestId: row.request_id,
    orderId: row.order_id,
    extensionId: row.extension_id,
    emailCodeSentAt: row.email_code_sent_at,
    status: row.status as VerificationCodeRequest['status'],
    emailCode: row.email_code ?? undefined,
    gmailAccountId: row.gmail_account_id ?? undefined,
    gmailMessageId: row.gmail_message_id ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function verificationToRow(request: VerificationCodeRequest) {
  return {
    requestId: request.requestId,
    orderId: request.orderId,
    extensionId: request.extensionId,
    emailCodeSentAt: request.emailCodeSentAt,
    status: request.status,
    emailCode: request.emailCode ?? null,
    gmailAccountId: request.gmailAccountId ?? null,
    gmailMessageId: request.gmailMessageId ?? null,
    error: request.error ?? null,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
  };
}

type GmailAccountRow = {
  id: string;
  email: string;
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  is_default: number;
  tokens_json: string;
};

function rowToGmailAccount(row: GmailAccountRow): GmailAccount {
  return {
    id: row.id,
    email: row.email,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at ?? undefined,
    lastError: row.last_error ?? undefined,
    isDefault: row.is_default === 1,
    tokens: JSON.parse(row.tokens_json)
  };
}

function gmailAccountToRow(account: GmailAccount) {
  return {
    id: account.id,
    email: account.email,
    connectedAt: account.connectedAt,
    lastSyncAt: account.lastSyncAt ?? null,
    lastError: account.lastError ?? null,
    isDefault: account.isDefault ? 1 : 0,
    tokensJson: JSON.stringify(account.tokens)
  };
}

export class OrderRepository {
  private readonly db: AppDatabase;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByExtensionStmt;

  constructor(db: AppDatabase = getOrdersDb()) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO orders (
        order_id, extension_id, status, input_json, output_json, error,
        created_at, updated_at, executing_at, execute_time_ms
      ) VALUES (
        @orderId, @extensionId, @status, @inputJson, @outputJson, @error,
        @createdAt, @updatedAt, @executingAt, @executeTimeMs
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE orders SET
        extension_id = @extensionId,
        status = @status,
        input_json = @inputJson,
        output_json = @outputJson,
        error = @error,
        updated_at = @updatedAt,
        executing_at = @executingAt,
        execute_time_ms = @executeTimeMs
      WHERE order_id = @orderId
    `);
    this.getStmt = db.prepare('SELECT * FROM orders WHERE order_id = ?');
    this.listStmt = db.prepare('SELECT * FROM orders ORDER BY created_at DESC');
    this.listByExtensionStmt = db.prepare('SELECT * FROM orders WHERE extension_id = ? ORDER BY created_at DESC');
  }

  private save(order: AutomationOrder): void {
    const row = orderToRow(order);
    if (this.get(order.orderId)) {
      this.updateStmt.run(row);
    } else {
      this.insertStmt.run(row);
    }
  }

  list(extensionId?: string): AutomationOrder[] {
    const rows = (extensionId ? this.listByExtensionStmt.all(extensionId) : this.listStmt.all()) as OrderRow[];
    return rows.map(rowToOrder);
  }

  get(orderId: string): AutomationOrder | undefined {
    const row = this.getStmt.get(orderId) as OrderRow | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  findActiveForExtension(extensionId: string): AutomationOrder | undefined {
    return this.list(extensionId).find(
      (order) => order.status === 'pending' || order.status === 'executing'
    );
  }

  expireStaleOrders(timeoutMs: number = ORDER_TIMEOUT_MS): AutomationOrder[] {
    const now = Date.now();
    const expired: AutomationOrder[] = [];
    for (const order of this.list()) {
      if (order.status !== 'pending' && order.status !== 'executing') continue;
      const startedAt = orderStartedAtMs(order);
      if (!Number.isFinite(startedAt) || now - startedAt < timeoutMs) continue;
      const failed = this.complete(order.orderId, {
        status: 'failed',
        error: 'Order timed out after 5 minutes'
      });
      if (failed) expired.push(failed);
    }
    return expired;
  }

  create(extensionId: string, input: WithdrawRequest): AutomationOrder {
    const order: AutomationOrder = {
      orderId: randomUUID(),
      extensionId,
      status: 'pending',
      input,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.save(order);
    return order;
  }

  markExecuting(orderId: string): AutomationOrder | null {
    const order = this.get(orderId);
    if (!order) return null;
    const updated: AutomationOrder = { ...order, status: 'executing', executingAt: nowIso(), updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }

  cancel(orderId: string): AutomationOrder | null {
    const order = this.get(orderId);
    if (!order) return null;
    if (order.status !== 'pending' && order.status !== 'executing') return null;
    const finishedAt = Date.now();
    const executingAtMs = order.executingAt ? new Date(order.executingAt).getTime() : undefined;
    const executeTimeMs =
      executingAtMs !== undefined && Number.isFinite(executingAtMs) ? Math.max(0, finishedAt - executingAtMs) : undefined;
    const updated: AutomationOrder = {
      ...order,
      status: 'cancelled',
      error: 'Cancelled by user',
      output: { completedAt: nowIso() },
      executeTimeMs,
      updatedAt: nowIso()
    };
    this.save(updated);
    return updated;
  }

  complete(
    orderId: string,
    patch: { status: 'completed' | 'failed'; output?: AutomationOrder['output']; error?: string }
  ): AutomationOrder | null {
    const order = this.get(orderId);
    if (!order) return null;
    if (order.status === 'completed' || order.status === 'failed' || order.status === 'cancelled') return order;
    const finishedAt = Date.now();
    const executingAtMs = order.executingAt ? new Date(order.executingAt).getTime() : undefined;
    const executeTimeMs =
      executingAtMs !== undefined && Number.isFinite(executingAtMs) ? Math.max(0, finishedAt - executingAtMs) : undefined;
    const completedAt = patch.output?.completedAt ?? nowIso();
    const output = patch.output ? { ...patch.output, completedAt } : { completedAt };
    const updated: AutomationOrder = { ...order, ...patch, output, executeTimeMs, updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }

  update(orderId: string, patch: Partial<AutomationOrder>): AutomationOrder | null {
    const order = this.get(orderId);
    if (!order) return null;
    const updated: AutomationOrder = { ...order, ...patch, orderId: order.orderId, updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }
}

export class TokenLaunchRepository {
  private readonly db: AppDatabase;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly getStmt;
  private readonly listStmt;

  constructor(db: AppDatabase = getTokenLaunchesDb()) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO token_launches (
        job_id, status, input_json, repeat_index, repeat_total, token_address, pool_address,
        deploy_block_number, trades_json, trades_synced_at, deploy_tx_hash, add_liquidity_tx_hash,
        buy_tx_hash, wallet3_buy_tx_hash, wallet1_buy_tx_hash, remove_liquidity_tx_hash,
        buyer_count, lp_removed, wallet2_buy_executed, wallet3_buy_executed, phase, error,
        created_at, updated_at, completed_at
      ) VALUES (
        @jobId, @status, @inputJson, @repeatIndex, @repeatTotal, @tokenAddress, @poolAddress,
        @deployBlockNumber, @tradesJson, @tradesSyncedAt, @deployTxHash, @addLiquidityTxHash,
        @buyTxHash, @wallet3BuyTxHash, @wallet1BuyTxHash, @removeLiquidityTxHash,
        @buyerCount, @lpRemoved, @wallet2BuyExecuted, @wallet3BuyExecuted, @phase, @error,
        @createdAt, @updatedAt, @completedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE token_launches SET
        status = @status,
        input_json = @inputJson,
        repeat_index = @repeatIndex,
        repeat_total = @repeatTotal,
        token_address = @tokenAddress,
        pool_address = @poolAddress,
        deploy_block_number = @deployBlockNumber,
        trades_json = @tradesJson,
        trades_synced_at = @tradesSyncedAt,
        deploy_tx_hash = @deployTxHash,
        add_liquidity_tx_hash = @addLiquidityTxHash,
        buy_tx_hash = @buyTxHash,
        wallet3_buy_tx_hash = @wallet3BuyTxHash,
        wallet1_buy_tx_hash = @wallet1BuyTxHash,
        remove_liquidity_tx_hash = @removeLiquidityTxHash,
        buyer_count = @buyerCount,
        lp_removed = @lpRemoved,
        wallet2_buy_executed = @wallet2BuyExecuted,
        wallet3_buy_executed = @wallet3BuyExecuted,
        phase = @phase,
        error = @error,
        updated_at = @updatedAt,
        completed_at = @completedAt
      WHERE job_id = @jobId
    `);
    this.getStmt = db.prepare('SELECT * FROM token_launches WHERE job_id = ?');
    this.listStmt = db.prepare('SELECT * FROM token_launches ORDER BY created_at DESC');
  }

  private save(job: TokenLaunchJob): void {
    const row = tokenLaunchToRow(job);
    if (this.get(job.jobId)) {
      this.updateStmt.run(row);
    } else {
      this.insertStmt.run(row);
    }
  }

  list(): TokenLaunchJob[] {
    return (this.listStmt.all() as TokenLaunchRow[]).map(rowToTokenLaunch);
  }

  get(jobId: string): TokenLaunchJob | undefined {
    const row = this.getStmt.get(jobId) as TokenLaunchRow | undefined;
    return row ? rowToTokenLaunch(row) : undefined;
  }

  findActive(): TokenLaunchJob | undefined {
    const activeStatuses = new Set<TokenLaunchJob['status']>([
      'pending',
      'deploying',
      'adding_liquidity',
      'monitoring',
      'buying',
      'removing_liquidity'
    ]);
    return this.list().find((job) => activeStatuses.has(job.status));
  }

  create(
    input: TokenLaunchInput,
    meta?: Pick<TokenLaunchJob, 'repeatIndex' | 'repeatTotal'>
  ): TokenLaunchJob {
    const repeatTotal = meta?.repeatTotal ?? input.repeatCount;
    const repeatIndex = meta?.repeatIndex;
    const queuedPhase =
      repeatTotal > 1 && repeatIndex ? `Queued (${repeatIndex}/${repeatTotal})` : 'Queued';
    const job: TokenLaunchJob = {
      jobId: randomUUID(),
      status: 'pending',
      input,
      repeatIndex,
      repeatTotal: repeatTotal > 1 ? repeatTotal : undefined,
      buyerCount: 0,
      lpRemoved: false,
      wallet2BuyExecuted: false,
      wallet3BuyExecuted: false,
      phase: queuedPhase,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.save(job);
    return job;
  }

  update(jobId: string, patch: Partial<TokenLaunchJob>): TokenLaunchJob | null {
    const job = this.get(jobId);
    if (!job) return null;
    const updated: TokenLaunchJob = { ...job, ...patch, jobId: job.jobId, updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }

  markLpRemovedForPool(poolAddress: string, removeLiquidityTxHash: string): TokenLaunchJob[] {
    const normalized = poolAddress.toLowerCase();
    const updated: TokenLaunchJob[] = [];
    for (const job of this.list()) {
      if (job.poolAddress?.toLowerCase() !== normalized) continue;
      const next: TokenLaunchJob = {
        ...job,
        lpRemoved: true,
        removeLiquidityTxHash,
        updatedAt: nowIso()
      };
      this.save(next);
      updated.push(next);
    }
    return updated;
  }
}

const ACTIVE_WORKFLOW_STATUSES = new Set<LaunchWorkflowStatus>([
  'pending',
  'creating_wallets',
  'withdrawing',
  'waiting_funds',
  'launching',
  'analyzing',
  'depositing'
]);

export function toPublicWorkflow(record: LaunchWorkflowRecord): LaunchWorkflow {
  const { storedWallets: _storedWallets, ...rest } = record;
  return rest;
}

export class WorkflowRepository {
  private readonly db: AppDatabase;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly getStmt;
  private readonly listStmt;

  constructor(db: AppDatabase = getWorkflowsDb()) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO workflows (
        workflow_id, status, phase, input_json, wallets_json, stored_wallets_json,
        withdraw_order_ids_json, launch_job_id, deposit_tx_hashes_json, analysis_json,
        error, created_at, updated_at, completed_at
      ) VALUES (
        @workflowId, @status, @phase, @inputJson, @walletsJson, @storedWalletsJson,
        @withdrawOrderIdsJson, @launchJobId, @depositTxHashesJson, @analysisJson,
        @error, @createdAt, @updatedAt, @completedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE workflows SET
        status = @status,
        phase = @phase,
        input_json = @inputJson,
        wallets_json = @walletsJson,
        stored_wallets_json = @storedWalletsJson,
        withdraw_order_ids_json = @withdrawOrderIdsJson,
        launch_job_id = @launchJobId,
        deposit_tx_hashes_json = @depositTxHashesJson,
        analysis_json = @analysisJson,
        error = @error,
        updated_at = @updatedAt,
        completed_at = @completedAt
      WHERE workflow_id = @workflowId
    `);
    this.getStmt = db.prepare('SELECT * FROM workflows WHERE workflow_id = ?');
    this.listStmt = db.prepare('SELECT * FROM workflows ORDER BY created_at DESC');
  }

  private save(workflow: LaunchWorkflowRecord): void {
    const row = workflowToRow(workflow);
    if (this.getRecord(workflow.workflowId)) {
      this.updateStmt.run(row);
    } else {
      this.insertStmt.run(row);
    }
  }

  list(): LaunchWorkflow[] {
    return (this.listStmt.all() as WorkflowRow[]).map(rowToWorkflow).map(toPublicWorkflow);
  }

  get(workflowId: string): LaunchWorkflow | undefined {
    const record = this.getRecord(workflowId);
    return record ? toPublicWorkflow(record) : undefined;
  }

  getRecord(workflowId: string): LaunchWorkflowRecord | undefined {
    const row = this.getStmt.get(workflowId) as WorkflowRow | undefined;
    return row ? rowToWorkflow(row) : undefined;
  }

  findActive(): LaunchWorkflowRecord | undefined {
    return (this.listStmt.all() as WorkflowRow[])
      .map(rowToWorkflow)
      .find((workflow) => ACTIVE_WORKFLOW_STATUSES.has(workflow.status));
  }

  create(input: LaunchWorkflowInput): LaunchWorkflowRecord {
    const workflow: LaunchWorkflowRecord = {
      workflowId: randomUUID(),
      status: 'pending',
      phase: 'Queued',
      input,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.save(workflow);
    return workflow;
  }

  update(workflowId: string, patch: Partial<LaunchWorkflowRecord>): LaunchWorkflowRecord | null {
    const workflow = this.getRecord(workflowId);
    if (!workflow) return null;
    const updated: LaunchWorkflowRecord = { ...workflow, ...patch, workflowId: workflow.workflowId, updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }

  setWallets(workflowId: string, wallets: StoredWorkflowWallet[]): LaunchWorkflowRecord | null {
    return this.update(workflowId, {
      storedWallets: wallets,
      wallets: wallets.map(({ index, address }) => ({ index, address }))
    });
  }
}

export class VerificationRepository {
  private readonly db: AppDatabase;
  private readonly insertStmt;
  private readonly updateStmt;
  private readonly getStmt;
  private readonly listStmt;
  private readonly listByExtensionStmt;

  constructor(db: AppDatabase = getVerificationDb()) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO verification_requests (
        request_id, order_id, extension_id, email_code_sent_at, status,
        email_code, gmail_account_id, gmail_message_id, error, created_at, updated_at
      ) VALUES (
        @requestId, @orderId, @extensionId, @emailCodeSentAt, @status,
        @emailCode, @gmailAccountId, @gmailMessageId, @error, @createdAt, @updatedAt
      )
    `);
    this.updateStmt = db.prepare(`
      UPDATE verification_requests SET
        order_id = @orderId,
        extension_id = @extensionId,
        email_code_sent_at = @emailCodeSentAt,
        status = @status,
        email_code = @emailCode,
        gmail_account_id = @gmailAccountId,
        gmail_message_id = @gmailMessageId,
        error = @error,
        updated_at = @updatedAt
      WHERE request_id = @requestId
    `);
    this.getStmt = db.prepare('SELECT * FROM verification_requests WHERE request_id = ?');
    this.listStmt = db.prepare('SELECT * FROM verification_requests ORDER BY created_at DESC');
    this.listByExtensionStmt = db.prepare(
      'SELECT * FROM verification_requests WHERE extension_id = ? ORDER BY created_at DESC'
    );
  }

  private save(request: VerificationCodeRequest): void {
    const row = verificationToRow(request);
    if (this.get(request.requestId)) {
      this.updateStmt.run(row);
    } else {
      this.insertStmt.run(row);
    }
  }

  create(input: { orderId: string; extensionId: string; emailCodeSentAt: number }): VerificationCodeRequest {
    const request: VerificationCodeRequest = {
      requestId: randomUUID(),
      orderId: input.orderId,
      extensionId: input.extensionId,
      emailCodeSentAt: input.emailCodeSentAt,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.save(request);
    return request;
  }

  get(requestId: string): VerificationCodeRequest | undefined {
    const row = this.getStmt.get(requestId) as VerificationRow | undefined;
    return row ? rowToVerification(row) : undefined;
  }

  update(
    requestId: string,
    patch: Partial<Pick<VerificationCodeRequest, 'status' | 'emailCode' | 'gmailAccountId' | 'gmailMessageId' | 'error'>>
  ): VerificationCodeRequest | null {
    const existing = this.get(requestId);
    if (!existing) return null;
    const updated: VerificationCodeRequest = { ...existing, ...patch, requestId: existing.requestId, updatedAt: nowIso() };
    this.save(updated);
    return updated;
  }

  list(extensionId?: string): VerificationCodeRequest[] {
    const rows = (
      extensionId ? this.listByExtensionStmt.all(extensionId) : this.listStmt.all()
    ) as VerificationRow[];
    return rows.map(rowToVerification);
  }
}

export class GmailRepository {
  private readonly db: AppDatabase;
  private readonly messagesByAccount = new Map<string, CachedGmailMessage[]>();
  private readonly insertAccountStmt;
  private readonly updateAccountStmt;
  private readonly deleteAccountStmt;
  private readonly listAccountsStmt;
  private readonly getAccountStmt;
  private readonly clearDefaultStmt;
  private readonly setDefaultStmt;
  private readonly insertUsedMessageStmt;
  private readonly listUsedMessagesStmt;
  private readonly getUsedMessageStmt;
  private readonly getSettingStmt;
  private readonly upsertSettingStmt;

  constructor(db: AppDatabase = getGmailDb()) {
    this.db = db;
    this.insertAccountStmt = db.prepare(`
      INSERT INTO gmail_accounts (
        id, email, connected_at, last_sync_at, last_error, is_default, tokens_json
      ) VALUES (
        @id, @email, @connectedAt, @lastSyncAt, @lastError, @isDefault, @tokensJson
      )
    `);
    this.updateAccountStmt = db.prepare(`
      UPDATE gmail_accounts SET
        email = @email,
        connected_at = @connectedAt,
        last_sync_at = @lastSyncAt,
        last_error = @lastError,
        is_default = @isDefault,
        tokens_json = @tokensJson
      WHERE id = @id
    `);
    this.deleteAccountStmt = db.prepare('DELETE FROM gmail_accounts WHERE id = ?');
    this.listAccountsStmt = db.prepare('SELECT * FROM gmail_accounts ORDER BY connected_at DESC');
    this.getAccountStmt = db.prepare('SELECT * FROM gmail_accounts WHERE id = ?');
    this.clearDefaultStmt = db.prepare('UPDATE gmail_accounts SET is_default = 0');
    this.setDefaultStmt = db.prepare('UPDATE gmail_accounts SET is_default = 1 WHERE id = ?');
    this.insertUsedMessageStmt = db.prepare(`
      INSERT OR IGNORE INTO gmail_used_messages (account_id, message_id, used_at, order_id)
      VALUES (@accountId, @messageId, @usedAt, @orderId)
    `);
    this.listUsedMessagesStmt = db.prepare('SELECT * FROM gmail_used_messages');
    this.getUsedMessageStmt = db.prepare(
      'SELECT 1 FROM gmail_used_messages WHERE account_id = ? AND message_id = ?'
    );
    this.getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    this.upsertSettingStmt = db.prepare(`
      INSERT INTO settings (key, value) VALUES (@key, @value)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
  }

  private usedKey(accountId: string, messageId: string): string {
    return `${accountId}:${messageId}`;
  }

  private getDefaultAccountId(): string | undefined {
    const row = this.getSettingStmt.get('gmail_default_account_id') as { value: string } | undefined;
    return row?.value;
  }

  private setDefaultAccountId(accountId: string | undefined): void {
    if (!accountId) {
      this.db.prepare("DELETE FROM settings WHERE key = 'gmail_default_account_id'").run();
      return;
    }
    this.upsertSettingStmt.run({ key: 'gmail_default_account_id', value: accountId });
  }

  private saveAccount(account: GmailAccount): void {
    const row = gmailAccountToRow(account);
    if (this.getAccount(account.id)) {
      this.updateAccountStmt.run(row);
    } else {
      this.insertAccountStmt.run(row);
    }
  }

  listAccounts(): GmailAccount[] {
    return (this.listAccountsStmt.all() as GmailAccountRow[]).map(rowToGmailAccount);
  }

  getAccount(accountId: string): GmailAccount | undefined {
    const row = this.getAccountStmt.get(accountId) as GmailAccountRow | undefined;
    return row ? rowToGmailAccount(row) : undefined;
  }

  getDefaultAccount(): GmailAccount | undefined {
    const defaultAccountId = this.getDefaultAccountId();
    if (defaultAccountId) {
      const selected = this.getAccount(defaultAccountId);
      if (selected) return selected;
    }
    return this.listAccounts()[0];
  }

  upsertAccount(account: GmailAccount): GmailAccount {
    const existing = this.getAccount(account.id);
    if (!existing) {
      if (this.listAccounts().length === 0) {
        account.isDefault = true;
        this.setDefaultAccountId(account.id);
      }
      this.saveAccount(account);
    } else {
      this.saveAccount(account);
    }
    if (account.isDefault) {
      this.setDefaultAccountId(account.id);
      this.clearDefaultStmt.run();
      this.setDefaultStmt.run(account.id);
      for (const other of this.listAccounts()) {
        if (other.id !== account.id && other.isDefault) {
          this.saveAccount({ ...other, isDefault: false });
        }
      }
    }
    return this.getAccount(account.id) || account;
  }

  removeAccount(accountId: string): boolean {
    const before = this.listAccounts().length;
    this.deleteAccountStmt.run(accountId);
    this.messagesByAccount.delete(accountId);
    const defaultAccountId = this.getDefaultAccountId();
    if (defaultAccountId === accountId) {
      const next = this.listAccounts()[0];
      this.setDefaultAccountId(next?.id);
      if (next) {
        this.clearDefaultStmt.run();
        this.setDefaultStmt.run(next.id);
      }
    }
    return this.listAccounts().length < before;
  }

  setDefault(accountId: string): GmailAccount | null {
    if (!this.getAccount(accountId)) return null;
    this.clearDefaultStmt.run();
    this.setDefaultStmt.run(accountId);
    this.setDefaultAccountId(accountId);
    for (const account of this.listAccounts()) {
      const shouldBeDefault = account.id === accountId;
      if (account.isDefault !== shouldBeDefault) {
        this.saveAccount({ ...account, isDefault: shouldBeDefault });
      }
    }
    return this.getAccount(accountId) || null;
  }

  updateAccount(accountId: string, patch: Partial<GmailAccount>): GmailAccount | null {
    const account = this.getAccount(accountId);
    if (!account) return null;
    const updated: GmailAccount = {
      ...account,
      ...patch,
      id: account.id,
      tokens: patch.tokens ? { ...account.tokens, ...patch.tokens } : account.tokens
    };
    return this.upsertAccount(updated);
  }

  listMessages(accountId?: string): CachedGmailMessage[] {
    if (accountId) return sortMessages(this.messagesByAccount.get(accountId) || []);
    return sortMessages([...this.messagesByAccount.values()].flat());
  }

  replaceMessages(accountId: string, messages: CachedGmailMessage[]): void {
    this.messagesByAccount.set(accountId, sortMessages(messages));
  }

  appendMessages(accountId: string, incoming: CachedGmailMessage[]): void {
    const merged = new Map<string, CachedGmailMessage>();
    [...incoming, ...(this.messagesByAccount.get(accountId) || [])].forEach((m) => merged.set(m.id, m));
    this.messagesByAccount.set(accountId, sortMessages([...merged.values()]));
  }

  publicView(account: GmailAccount): Omit<GmailAccount, 'tokens'> {
    const { tokens: _tokens, ...rest } = account;
    return rest;
  }

  isMessageUsed(accountId: string, messageId: string): boolean {
    return Boolean(this.getUsedMessageStmt.get(accountId, messageId));
  }

  markMessageUsed(input: { accountId: string; messageId: string; orderId?: string }): void {
    if (this.isMessageUsed(input.accountId, input.messageId)) return;
    this.insertUsedMessageStmt.run({
      accountId: input.accountId,
      messageId: input.messageId,
      usedAt: nowIso(),
      orderId: input.orderId ?? null
    });
  }
}
