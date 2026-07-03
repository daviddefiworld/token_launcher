import { getOrders } from './api';
import type { ActivityItem, AutomationOrder, LaunchWorkflow, LaunchWorkflowStatus, TokenLaunchJob, VerificationCodeRequest } from './types';

export const ORDER_CANCELLED_MESSAGE = 'Order cancelled';

const ACTIVE_ORDER_STATUSES = new Set<AutomationOrder['status']>(['pending', 'executing']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function waitForExtensionIdle(
  extensionId: string,
  options?: { pollMs?: number; maxWaitMs?: number; stableMs?: number }
): Promise<void> {
  const pollMs = options?.pollMs ?? 1000;
  const stableMs = options?.stableMs ?? 800;
  const maxWaitMs = options?.maxWaitMs ?? 30 * 60 * 1000;
  const deadline = Date.now() + maxWaitMs;
  let idleSince: number | null = null;
  let sawActive = false;

  while (Date.now() < deadline) {
    const orders = await getOrders(extensionId);
    const hasActive = orders.some((order) => ACTIVE_ORDER_STATUSES.has(order.status));
    if (!hasActive) {
      if (!sawActive) {
        return;
      }
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= stableMs) {
        return;
      }
    } else {
      sawActive = true;
      idleSince = null;
    }
    await sleep(pollMs);
  }

  throw new Error('Timed out waiting for extension to become idle');
}

export async function waitForOrderCompleted(
  extensionId: string,
  orderId: string,
  options?: { pollMs?: number; maxWaitMs?: number }
): Promise<AutomationOrder> {
  const pollMs = options?.pollMs ?? 2000;
  const maxWaitMs = options?.maxWaitMs ?? 30 * 60 * 1000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const orders = await getOrders(extensionId);
    const order = orders.find((item) => item.orderId === orderId);
    if (order?.status === 'completed') {
      return order;
    }
    if (order?.status === 'cancelled') {
      throw new Error(ORDER_CANCELLED_MESSAGE);
    }
    if (order?.status === 'failed') {
      throw new Error(order.error || 'Order failed');
    }
    await sleep(pollMs);
  }

  throw new Error('Timed out waiting for order to complete');
}

export function formatRelativeTime(value: string | undefined): string {
  if (!value) return 'never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function formatUtcTime(value: string | undefined): string {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function shortId(id: string): string {
  return id.length > 20 ? `${id.slice(0, 18)}…` : id;
}

export function orderCompletedAt(order: { status: string; output?: { completedAt?: string }; updatedAt: string }): string | undefined {
  if (order.status !== 'completed' && order.status !== 'failed' && order.status !== 'cancelled') return undefined;
  return order.output?.completedAt ?? order.updatedAt;
}

export function orderStatusClass(status: string): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed') return 'pill danger';
  if (status === 'cancelled') return 'pill warning';
  if (status === 'executing' || status === 'pending') return 'pill muted';
  return 'pill';
}

export function isActiveOrderStatus(status: AutomationOrder['status']): boolean {
  return ACTIVE_ORDER_STATUSES.has(status);
}

const WORKFLOW_DEPOSIT_BLOCKING_STATUSES = new Set<LaunchWorkflowStatus>([
  'pending',
  'creating_wallets',
  'withdrawing',
  'waiting_funds',
  'launching',
  'analyzing'
]);

export function canDepositWorkflow(workflow: Pick<LaunchWorkflow, 'status' | 'wallets'>): boolean {
  if (!workflow.wallets?.length) return false;
  return !WORKFLOW_DEPOSIT_BLOCKING_STATUSES.has(workflow.status);
}

export function canDepositWorkflowActivity(item: ActivityItem): boolean {
  if (item.kind !== 'launch_workflow') return false;
  if (!item.launchWorkflow?.hasWallets) return false;
  return !WORKFLOW_DEPOSIT_BLOCKING_STATUSES.has(item.status as LaunchWorkflowStatus);
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

export function upsertById<T extends { createdAt: string }>(
  list: T[],
  item: T,
  idOf: (entry: T) => string,
  id: string
): T[] {
  const index = list.findIndex((entry) => idOf(entry) === id);
  if (index === -1) return [item, ...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const next = [...list];
  next[index] = item;
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export class ActivityMapper {
  static fromOrder(order: AutomationOrder): ActivityItem {
    return {
      id: order.orderId,
      kind: 'withdraw',
      extensionId: order.extensionId,
      status: order.status,
      title: order.input.text,
      summary: `${order.input.amount} ${order.input.currency} on ${order.input.chain} → ${order.input.address}`,
      withdraw: {
        currency: order.input.currency,
        chain: order.input.chain,
        address: order.input.address,
        amount: order.input.amount,
        text: order.input.text
      },
      error: order.error,
      message: order.output?.message,
      pageUrl: order.output?.pageUrl,
      executeTimeMs: order.executeTimeMs,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  static fromVerification(request: VerificationCodeRequest): ActivityItem {
    const sentLabel = new Date(request.emailCodeSentAt).toISOString();
    return {
      id: request.requestId,
      kind: 'email_verification',
      extensionId: request.extensionId,
      status: request.status,
      title: 'Gmail verification code',
      summary: `Withdraw order ${request.orderId.slice(0, 8)}… · after ${sentLabel}`,
      parentOrderId: request.orderId,
      emailCode: request.emailCode,
      emailCodeSentAt: request.emailCodeSentAt,
      error: request.error,
      message: request.status === 'completed' ? `Code ${request.emailCode}` : undefined,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
    };
  }

  static fromTokenLaunch(job: TokenLaunchJob): ActivityItem {
    return {
      id: job.jobId,
      kind: 'token_launch',
      extensionId: 'tokenlaunch',
      status: job.status,
      title: `Token launch: ${job.input.tokenName}`,
      summary: `${job.input.dex === 'uniswap' ? 'Uniswap V2' : 'Aerodrome'} · ${job.input.lpEthAmount} ETH LP on Base · ${job.phase || job.status}`,
      tokenLaunch: {
        tokenName: job.input.tokenName,
        tokenSymbol: job.input.tokenSymbol,
        lpEthAmount: job.input.lpEthAmount,
        buyEthAmount: job.input.buyEthAmount,
        tokenAddress: job.tokenAddress,
        poolAddress: job.poolAddress,
        buyerCount: job.buyerCount,
        phase: job.phase
      },
      error: job.error,
      message: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  static fromLaunchWorkflow(workflow: LaunchWorkflow): ActivityItem {
    return {
      id: workflow.workflowId,
      kind: 'launch_workflow',
      extensionId: workflow.input.extensionId,
      status: workflow.status,
      title: `Launch workflow: ${workflow.input.tokenLaunch.tokenName}`,
      summary: `${workflow.input.walletCount} wallets · ${workflow.phase || workflow.status}`,
      launchWorkflow: {
        walletCount: workflow.input.walletCount,
        autoStartLaunch: workflow.input.autoStartLaunch,
        launchJobId: workflow.launchJobId,
        phase: workflow.phase,
        hasWallets: Boolean(workflow.wallets?.length)
      },
      error: workflow.error,
      message: workflow.phase,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt
    };
  }
}
