import { listVerificationRequests } from './verification-requests/store';
import type { VerificationCodeRequest } from './verification-requests/types';

export type ActivityKind = 'withdraw' | 'email_verification';

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  extensionId: string;
  status: string;
  title: string;
  summary?: string;
  parentOrderId?: string;
  emailCode?: string;
  emailCodeSentAt?: number;
  withdraw?: {
    currency: string;
    chain: string;
    address: string;
    amount: string;
    text: string;
  };
  error?: string;
  message?: string;
  pageUrl?: string;
  executeTimeMs?: number;
  createdAt: string;
  updatedAt: string;
}

interface WithdrawOrder {
  orderId: string;
  extensionId: string;
  status: string;
  input: {
    text: string;
    currency: string;
    chain: string;
    address: string;
    amount: string;
  };
  output?: { message?: string; pageUrl?: string };
  error?: string;
  executeTimeMs?: number;
  createdAt: string;
  updatedAt: string;
}

function verificationToActivity(request: VerificationCodeRequest): ActivityItem {
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

function withdrawToActivity(order: WithdrawOrder): ActivityItem {
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

export function buildActivityFeed(withdrawOrders: WithdrawOrder[], extensionId?: string): ActivityItem[] {
  const verification = listVerificationRequests(extensionId);
  const items = [
    ...withdrawOrders
      .filter((order) => !extensionId || order.extensionId === extensionId)
      .map(withdrawToActivity),
    ...verification.map(verificationToActivity)
  ];
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
