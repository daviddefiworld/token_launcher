export type OrderStatus = 'pending' | 'executing' | 'completed' | 'failed';
export type VerificationRequestStatus = 'pending' | 'completed' | 'failed';
export type ActivityKind = 'withdraw' | 'email_verification';

export interface WithdrawRequest {
  text: string;
  currency: string;
  chain: string;
  address: string;
  amount: string;
  emailCode?: string;
  authenticatorCode?: string;
}

export interface AutomationOrder {
  orderId: string;
  extensionId: string;
  status: OrderStatus;
  input: WithdrawRequest;
  output?: {
    message?: string;
    pageUrl?: string;
    pageTitle?: string;
    completedAt?: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
  executingAt?: string;
  executeTimeMs?: number;
}

export interface ExtensionRecord {
  extensionId: string;
  socketId: string;
  connectedAt: string;
  lastSeen: string;
  isOnline: boolean;
  currentUrl?: string;
  userAgent?: string;
  version?: string;
}

export interface GmailTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  token_type?: string | null;
  id_token?: string | null;
}

export interface GmailAccount {
  id: string;
  email: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  isDefault: boolean;
  tokens: GmailTokens;
}

export interface CachedGmailMessage {
  id: string;
  accountId: string;
  subject: string;
  from: string;
  receivedAt: string;
  snippet: string;
  verificationCode?: string;
}

export interface UsedGmailMessage {
  accountId: string;
  messageId: string;
  usedAt: string;
  orderId?: string;
}

export interface GmailStoreSnapshot {
  accounts: GmailAccount[];
  defaultAccountId?: string;
  usedMessages?: UsedGmailMessage[];
}

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
