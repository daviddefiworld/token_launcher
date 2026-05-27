export type VerificationRequestStatus = 'pending' | 'completed' | 'failed';

export interface VerificationCodeRequest {
  requestId: string;
  orderId: string;
  extensionId: string;
  emailCodeSentAt: number;
  status: VerificationRequestStatus;
  emailCode?: string;
  gmailAccountId?: string;
  gmailMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
