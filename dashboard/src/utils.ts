import type { ActivityItem, AutomationOrder, VerificationCodeRequest } from './types';

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
  if (order.status !== 'completed' && order.status !== 'failed') return undefined;
  return order.output?.completedAt ?? order.updatedAt;
}

export function orderStatusClass(status: string): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed') return 'pill danger';
  if (status === 'executing' || status === 'pending') return 'pill muted';
  return 'pill';
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
}
