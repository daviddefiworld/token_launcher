export type OrderStatus = 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
export type VerificationRequestStatus = 'pending' | 'completed' | 'failed';
export type ActivityKind = 'withdraw' | 'email_verification' | 'token_launch' | 'launch_workflow';

export type LaunchWorkflowStatus =
  | 'pending'
  | 'creating_wallets'
  | 'withdrawing'
  | 'waiting_funds'
  | 'launching'
  | 'analyzing'
  | 'depositing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface StoredWorkflowWallet {
  index: 1 | 2 | 3;
  address: string;
  privateKey: string;
}

export interface LaunchWorkflowInput {
  extensionId: string;
  /** 2 = deploy + buy wallets; 3 = adds a third buy wallet */
  walletCount: 2 | 3;
  autoStartLaunch: boolean;
  analyzeOnComplete: boolean;
  wallet1WithdrawAmount?: string;
  wallet2WithdrawAmount?: string;
  wallet3WithdrawAmount?: string;
  tokenLaunch: TokenLaunchInput;
}

export interface LaunchWorkflowPublicWallet {
  index: 1 | 2 | 3;
  address: string;
}

export interface LaunchWorkflow {
  workflowId: string;
  status: LaunchWorkflowStatus;
  phase?: string;
  input: LaunchWorkflowInput;
  wallets?: LaunchWorkflowPublicWallet[];
  withdrawOrderIds?: string[];
  launchJobId?: string;
  depositTxHashes?: string[];
  analysis?: TokenLaunchTradesResponse;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** Internal persisted record — includes private keys for crash recovery */
export interface LaunchWorkflowRecord extends LaunchWorkflow {
  storedWallets?: StoredWorkflowWallet[];
}

export type TokenLaunchStatus =
  | 'pending'
  | 'deploying'
  | 'adding_liquidity'
  | 'monitoring'
  | 'buying'
  | 'removing_liquidity'
  | 'completed'
  | 'failed';

/** DEX to launch on. Both are constant-product AMMs on Base. */
export type DexKey = 'aerodrome' | 'uniswap';

export interface TokenLaunchInput {
  /**
   * DEX to deploy LP on. New launches default to 'uniswap' (set by the parser).
   * Absent on legacy jobs, which are treated as 'aerodrome' at runtime.
   */
  dex?: DexKey;
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

export type PoolTradeSide = 'buy' | 'sell';

export interface PoolTrade {
  logIndex: number;
  txHash: string;
  blockNumber: number;
  timestamp: string;
  side: PoolTradeSide;
  trader: string;
  tokenAmount: string;
  ethAmount: string;
  tokenAmountFormatted: string;
  ethAmountFormatted: string;
  isOwnWallet: boolean;
  /** ETH value is below MIN_DETECTION_BUY_ETH — shown/counted but ignored for buyer detection. */
  belowDetectionThreshold?: boolean;
}

export interface LaunchTradeStats {
  totalSwaps: number;
  buys: number;
  sells: number;
  /** Unique external buyers seen (includes sub-threshold dust buys). */
  externalBuyers: number;
  /** Unique external buyers whose buy met MIN_DETECTION_BUY_ETH — drives detection. */
  qualifyingBuyers: number;
  externalSellers: number;
  ownWalletSwaps: number;
}

export interface TokenLaunchTradesResponse {
  jobId: string;
  tokenAddress: string;
  poolAddress: string;
  trades: PoolTrade[];
  stats: LaunchTradeStats;
  tradesSyncedAt?: string;
}

export interface TokenLaunchTradesBackfillResult {
  processed: number;
  skipped: number;
  failed: { jobId: string; error: string }[];
}

export interface TokenLaunchJob {
  jobId: string;
  status: TokenLaunchStatus;
  input: TokenLaunchInput;
  repeatIndex?: number;
  repeatTotal?: number;
  tokenAddress?: string;
  poolAddress?: string;
  deployBlockNumber?: number;
  trades?: PoolTrade[];
  tradesSyncedAt?: string;
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
  dex?: DexKey;
}

export interface LpRemovalResult {
  poolAddress: string;
  tokenAddress: string;
  txHash?: string;
  success: boolean;
  error?: string;
}

/**
 * Contract used by a manual (deploy-only) token deploy.
 * 'normal' = plain ERC-20 (LaunchToken.sol, constructor takes name/symbol/supply).
 * 'tax' = fee-on-transfer token — name/symbol/supply/taxes are hardcoded in the compiled contract.
 */
export type TokenDeployType = 'normal' | 'tax';

export interface ManualTokenDeployInput {
  tokenType: TokenDeployType;
  /** Required for 'normal'; ignored for 'tax' (contract-defined). */
  tokenName?: string;
  tokenSymbol?: string;
  /** Human units, scaled by 18 decimals ('normal' only). */
  totalSupply?: string;
}

/** A token deployed from the manual launch page (deploy only — no LP, no monitoring). */
export interface DeployedTokenRecord {
  id: string;
  tokenType: TokenDeployType;
  tokenAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  totalSupply?: string;
  deployTxHash: string;
  deployerAddress: string;
  createdAt: string;
}

/** An LP position created from the manual liquidity page, saved so it can be removed later. */
export interface ManualLpRecord {
  poolAddress: string;
  tokenAddress: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  dex: DexKey;
  addTxHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LpPosition extends ManualLpRecord {
  /** Wallet 1's raw LP-token balance for the pool. */
  lpBalance: string;
  /** Wallet 1's share of the pool reserves, in human units. Absent when reserves can't be read. */
  pooledToken?: string;
  pooledEth?: string;
}

export interface AddLiquidityInput {
  tokenAddress: string;
  /** Token amount in human units — scaled by the token's own `decimals()`. */
  tokenAmount: string;
  ethAmount: string;
}

export interface AddLiquidityResult {
  position: LpPosition;
  approveTxHash?: string;
  addTxHash: string;
}

export interface RemoveLiquidityInput {
  poolAddress?: string;
  tokenAddress?: string;
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
  launchWorkflow?: {
    walletCount: 2 | 3;
    autoStartLaunch: boolean;
    launchJobId?: string;
    phase?: string;
    hasWallets?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}
