import { randomUUID } from 'crypto';
import type { VerificationCodeRequest, VerificationRequestStatus } from './types';

const requests = new Map<string, VerificationCodeRequest>();

function nowIso(): string {
  return new Date().toISOString();
}

export function createVerificationRequest(input: {
  orderId: string;
  extensionId: string;
  emailCodeSentAt: number;
}): VerificationCodeRequest {
  const request: VerificationCodeRequest = {
    requestId: randomUUID(),
    orderId: input.orderId,
    extensionId: input.extensionId,
    emailCodeSentAt: input.emailCodeSentAt,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  requests.set(request.requestId, request);
  return request;
}

export function getVerificationRequest(requestId: string): VerificationCodeRequest | undefined {
  return requests.get(requestId);
}

export function getVerificationRequestByOrderId(orderId: string): VerificationCodeRequest | undefined {
  return [...requests.values()]
    .filter((request) => request.orderId === orderId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function updateVerificationRequest(
  requestId: string,
  patch: Partial<Pick<VerificationCodeRequest, 'status' | 'emailCode' | 'gmailAccountId' | 'gmailMessageId' | 'error'>>
): VerificationCodeRequest | null {
  const existing = requests.get(requestId);
  if (!existing) return null;
  const updated: VerificationCodeRequest = {
    ...existing,
    ...patch,
    requestId: existing.requestId,
    updatedAt: nowIso()
  };
  requests.set(requestId, updated);
  return updated;
}

export function listVerificationRequests(extensionId?: string): VerificationCodeRequest[] {
  const all = [...requests.values()];
  const filtered = extensionId ? all.filter((request) => request.extensionId === extensionId) : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function publicVerificationRequest(request: VerificationCodeRequest): VerificationCodeRequest {
  return { ...request };
}
