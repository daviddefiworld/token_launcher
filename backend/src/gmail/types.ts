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
