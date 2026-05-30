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

export type OrderStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';

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
  executingAt?: string;
  executeTimeMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GmailAccount {
  id: string;
  email: string;
  connectedAt: string;
  lastSyncAt?: string;
  lastError?: string;
  isDefault: boolean;
}

export interface GmailStatus {
  configured: boolean;
  accounts: GmailAccount[];
}

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
  wallet2BuyEthAmount: string;
  buyEthAmount: string;
  useWallet3: boolean;
  buyAfterSeconds: number;
  repeatCount: number;
  removeLp: boolean;
  removeLpTimeMinutes: number;
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

export interface TokenLaunchStatusResponse {
  configured: boolean;
  wallet1Address?: string;
  wallet2Address?: string;
  wallet3Address?: string;
  wallet3Configured?: boolean;
  rpcUrl: string;
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

export interface VerificationCodeRequest {
  requestId: string;
  orderId: string;
  extensionId: string;
  emailCodeSentAt: number;
  status: 'pending' | 'completed' | 'failed';
  emailCode?: string;
  gmailAccountId?: string;
  gmailMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
