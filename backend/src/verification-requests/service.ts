import type { Server } from 'socket.io';
import { waitForVerificationCode } from '../gmail/service';
import {
  createVerificationRequest,
  getVerificationRequest,
  publicVerificationRequest,
  updateVerificationRequest
} from './store';
import type { VerificationCodeRequest } from './types';

let ioRef: Server | null = null;

export function setVerificationSocketServer(io: Server): void {
  ioRef = io;
}

function emitToExtension(extensionId: string, event: string, payload: unknown): void {
  if (!ioRef) return;
  for (const [, socket] of ioRef.sockets.sockets) {
    if (socket.data.extensionId === extensionId) {
      socket.emit(event, payload);
    }
  }
}

export function startVerificationCodeRequest(input: {
  orderId: string;
  extensionId: string;
  emailCodeSentAt: number;
}): VerificationCodeRequest {
  const request = createVerificationRequest(input);
  ioRef?.to('dashboards').emit('verification-requests:created', { request: publicVerificationRequest(request) });

  void (async () => {
    try {
      const result = await waitForVerificationCode(input.emailCodeSentAt, { orderId: input.orderId });
      const completed = updateVerificationRequest(request.requestId, {
        status: 'completed',
        emailCode: result.emailCode,
        gmailAccountId: result.accountId,
        gmailMessageId: result.messageId,
        error: undefined
      });
      if (!completed) return;

      emitToExtension(input.extensionId, 'extension:verification_code_ready', {
        orderId: input.orderId,
        requestId: completed.requestId,
        emailCode: result.emailCode
      });
      ioRef?.to('dashboards').emit('verification-requests:updated', { request: publicVerificationRequest(completed) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Verification code lookup failed';
      const failed = updateVerificationRequest(request.requestId, {
        status: 'failed',
        error: message
      });
      if (!failed) return;

      emitToExtension(input.extensionId, 'extension:verification_code_failed', {
        orderId: input.orderId,
        requestId: failed.requestId,
        error: message
      });
      ioRef?.to('dashboards').emit('verification-requests:updated', { request: publicVerificationRequest(failed) });
    }
  })();

  return request;
}

export function getPublicVerificationRequest(requestId: string): VerificationCodeRequest | null {
  const request = getVerificationRequest(requestId);
  return request ? publicVerificationRequest(request) : null;
}
