export type OrderStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
export type VerificationRequestStatus = 'pending' | 'completed' | 'failed';
export type ActivityKind = 'withdraw' | 'email_verification' | 'token_launch';

export type TokenLaunchStatus =
  | 'pending'
  | 'deploying'
  | 'adding_liquidity'
  | 'monitoring'
  | 'buying'
  | 'removing_liquidity'
  | 'completed'
  | 'failed';

export interface TokenLaunchInput {
  tokenName: string;
  tokenSymbol: string;
  lpEthAmount: string;
  /** Wallet 2 buy amount (ETH). Falls back to buyEthAmount on older jobs. */
  wallet2BuyEthAmount?: string;
  /** Wallet 3 buy amount (ETH). */
  buyEthAmount: string;
  /** When true, wallet 3 participates in auto/manual buys (requires WALLET_3_PRIVATE_KEY). */
  useWallet3?: boolean;
  /** Seconds to wait with no external buyers before wallets 2/3 buy (default 30). */
  buyAfterSeconds?: number;
  repeatCount: number;
  /** When true (default), remove LP on buyer or after removeLpTimeMinutes. When false, leave LP for manual removal. */
  removeLp: boolean;
  /** Minutes to monitor before timed LP removal / job end (default 5). */
  removeLpTimeMinutes: number;
  /** External buyers required before early LP removal / early completion (default 1). */
  minBuyersBeforeRemoveLp: number;
}

export interface TokenLaunchJob {
  jobId: string;
  status: TokenLaunchStatus;
  input: TokenLaunchInput;
  repeatIndex?: number;
  repeatTotal?: number;
  tokenAddress?: string;
  poolAddress?: string;
  deployTxHash?: string;
  addLiquidityTxHash?: string;
  buyTxHash?: string;
  wallet3BuyTxHash?: string;
  wallet1BuyTxHash?: string;
  removeLiquidityTxHash?: string;
  buyerCount: number;
  lpRemoved: boolean;
  wallet2BuyExecuted: boolean;
  wallet3BuyExecuted?: boolean;
  phase?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface UnremovedLpPosition {
  poolAddress: string;
  tokenAddress: string;
  lpBalance: string;
  jobIds: string[];
  tokenName?: string;
  tokenSymbol?: string;
}

export interface LpRemovalResult {
  poolAddress: string;
  tokenAddress: string;
  txHash?: string;
  success: boolean;
  error?: string;
}

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
  tokenLaunch?: {
    tokenName: string;
    tokenSymbol: string;
    lpEthAmount: string;
    buyEthAmount: string;
    tokenAddress?: string;
    poolAddress?: string;
    buyerCount?: number;
    phase?: string;
  };
  createdAt: string;
  updatedAt: string;
}
