import type {
  ActivityItem,
  AddLiquidityInput,
  AddLiquidityResult,
  AutomationOrder,
  CachedGmailMessage,
  DeployedToken,
  ExtensionRecord,
  GmailAccount,
  GmailStatus,
  LaunchWorkflow,
  LaunchWorkflowInput,
  LpPosition,
  ManualTokenDeployInput,
  TokenLaunchInput,
  TokenLaunchJob,
  TokenLaunchStatusResponse,
  TokenLaunchTradesBackfillResult,
  TokenLaunchTradesResponse,
  UnremovedLpPosition,
  LpRemovalResult
} from './types';

export type { TokenLaunchInput, LaunchWorkflowInput, AddLiquidityInput, ManualTokenDeployInput };

export interface WithdrawOrderInput {
  currency: string;
  chain: string;
  address: string;
  amount: string;
  emailCode?: string;
  authenticatorCode?: string;
}

class BackendClient {
  constructor(private readonly baseUrl: string) {}

  get url(): string {
    return this.baseUrl;
  }

  private async readJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers }
    });
    const body = (await response.json()) as { success: boolean; data?: T; error?: string };
    if (!response.ok || !body.success) {
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return body.data as T;
  }

  getExtensions(): Promise<ExtensionRecord[]> {
    return this.readJson('/api/extensions');
  }

  getOrders(extensionId?: string): Promise<AutomationOrder[]> {
    const params = extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : '';
    return this.readJson(`/api/orders${params}`);
  }

  getActivity(extensionId?: string): Promise<ActivityItem[]> {
    const params = extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : '';
    return this.readJson(`/api/activity${params}`);
  }

  createOrder(extensionId: string, input: WithdrawOrderInput): Promise<AutomationOrder> {
    return this.readJson(`/api/extensions/${encodeURIComponent(extensionId)}/orders`, {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  cancelOrder(orderId: string): Promise<AutomationOrder> {
    return this.readJson(`/api/orders/${encodeURIComponent(orderId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  getTokenLaunchStatus(): Promise<TokenLaunchStatusResponse> {
    return this.readJson('/api/tokenlaunch/status');
  }

  getTokenLaunchJobs(): Promise<TokenLaunchJob[]> {
    return this.readJson('/api/tokenlaunch');
  }

  getTokenLaunchTrades(jobId: string, refresh = false): Promise<TokenLaunchTradesResponse> {
    const params = refresh ? '?refresh=true' : '';
    return this.readJson(`/api/tokenlaunch/${encodeURIComponent(jobId)}/trades${params}`);
  }

  backfillTokenLaunchTrades(onlyMissing = false): Promise<TokenLaunchTradesBackfillResult> {
    return this.readJson('/api/tokenlaunch/trades/backfill', {
      method: 'POST',
      body: JSON.stringify({ onlyMissing })
    });
  }

  startTokenLaunch(input: TokenLaunchInput): Promise<TokenLaunchJob> {
    return this.readJson('/api/tokenlaunch', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  manualTokenLaunchBuy(
    jobId: string,
    wallet: 2 | 3,
    ethAmount?: string
  ): Promise<TokenLaunchJob> {
    return this.readJson(`/api/tokenlaunch/${encodeURIComponent(jobId)}/buy`, {
      method: 'POST',
      body: JSON.stringify(ethAmount ? { wallet, ethAmount } : { wallet })
    });
  }

  finishTokenLaunch(jobId: string): Promise<TokenLaunchJob> {
    return this.readJson(`/api/tokenlaunch/${encodeURIComponent(jobId)}/finish`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  getUnremovedLp(): Promise<UnremovedLpPosition[]> {
    return this.readJson('/api/tokenlaunch/lp/unremoved');
  }

  removeUnremovedLp(input: { poolAddress: string } | { all: true }): Promise<LpRemovalResult[]> {
    return this.readJson('/api/tokenlaunch/lp/remove', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  getDeployedTokens(): Promise<DeployedToken[]> {
    return this.readJson('/api/deploy');
  }

  deployToken(input: ManualTokenDeployInput): Promise<DeployedToken> {
    return this.readJson('/api/deploy', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  getLpPositions(): Promise<LpPosition[]> {
    return this.readJson('/api/liquidity');
  }

  lookupLpPosition(tokenAddress: string): Promise<LpPosition | null> {
    return this.readJson(`/api/liquidity/lookup?tokenAddress=${encodeURIComponent(tokenAddress)}`);
  }

  addLiquidity(input: AddLiquidityInput): Promise<AddLiquidityResult> {
    return this.readJson('/api/liquidity/add', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  removeLiquidity(input: { poolAddress: string } | { tokenAddress: string }): Promise<LpRemovalResult> {
    return this.readJson('/api/liquidity/remove', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  getLaunchWorkflows(): Promise<LaunchWorkflow[]> {
    return this.readJson('/api/workflows');
  }

  getLaunchWorkflow(workflowId: string): Promise<LaunchWorkflow> {
    return this.readJson(`/api/workflows/${encodeURIComponent(workflowId)}`);
  }

  startLaunchWorkflow(input: LaunchWorkflowInput): Promise<LaunchWorkflow> {
    return this.readJson('/api/workflows', {
      method: 'POST',
      body: JSON.stringify(input)
    });
  }

  cancelLaunchWorkflow(workflowId: string): Promise<LaunchWorkflow> {
    return this.readJson(`/api/workflows/${encodeURIComponent(workflowId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  depositLaunchWorkflow(workflowId: string): Promise<LaunchWorkflow> {
    return this.readJson(`/api/workflows/${encodeURIComponent(workflowId)}/deposit`, {
      method: 'POST',
      body: JSON.stringify({})
    });
  }

  getGmailStatus(): Promise<GmailStatus> {
    return this.readJson('/api/gmails/status');
  }

  getGmailAccounts(): Promise<GmailAccount[]> {
    return this.readJson('/api/gmails');
  }

  getGmailMessages(accountId?: string): Promise<CachedGmailMessage[]> {
    const params = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return this.readJson(`/api/gmails/messages${params}`);
  }

  async getGmailConnectUrl(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/gmails/connect-url`);
    const body = (await response.json()) as { success: boolean; data?: { url: string }; error?: string };
    if (!response.ok || !body.success || !body.data?.url) {
      throw new Error(body.error || 'Could not start Gmail connection');
    }
    return body.data.url;
  }

  syncGmailAccounts(): Promise<GmailAccount[]> {
    return this.readJson('/api/gmails/sync', { method: 'POST' });
  }

  syncGmailAccount(accountId: string): Promise<GmailAccount> {
    return this.readJson(`/api/gmails/${encodeURIComponent(accountId)}/sync`, { method: 'POST' });
  }

  setDefaultGmailAccount(accountId: string): Promise<GmailAccount> {
    return this.readJson(`/api/gmails/${encodeURIComponent(accountId)}/default`, { method: 'POST' });
  }

  async disconnectGmailAccount(accountId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/gmails/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
    const body = (await response.json()) as { success: boolean; error?: string };
    if (!response.ok || !body.success) {
      throw new Error(body.error || 'Could not disconnect Gmail account');
    }
  }
}

const client = new BackendClient(import.meta.env.VITE_TOKEN_BACKEND_URL || 'http://localhost:5050');

export const getBackendUrl = () => client.url;
export const getExtensions = () => client.getExtensions();
export const getOrders = (extensionId?: string) => client.getOrders(extensionId);
export const getActivity = (extensionId?: string) => client.getActivity(extensionId);
export const createOrder = (extensionId: string, input: WithdrawOrderInput) => client.createOrder(extensionId, input);
export const cancelOrder = (orderId: string) => client.cancelOrder(orderId);
export const getTokenLaunchStatus = () => client.getTokenLaunchStatus();
export const getTokenLaunchJobs = () => client.getTokenLaunchJobs();
export const getTokenLaunchTrades = (jobId: string, refresh = false) =>
  client.getTokenLaunchTrades(jobId, refresh);
export const backfillTokenLaunchTrades = (onlyMissing = false) =>
  client.backfillTokenLaunchTrades(onlyMissing);
export const startTokenLaunch = (input: TokenLaunchInput) => client.startTokenLaunch(input);
export const manualTokenLaunchBuy = (jobId: string, wallet: 2 | 3, ethAmount?: string) =>
  client.manualTokenLaunchBuy(jobId, wallet, ethAmount);
export const finishTokenLaunch = (jobId: string) => client.finishTokenLaunch(jobId);
export const getUnremovedLp = () => client.getUnremovedLp();
export const removeUnremovedLp = (input: { poolAddress: string } | { all: true }) =>
  client.removeUnremovedLp(input);
export const getDeployedTokens = () => client.getDeployedTokens();
export const deployToken = (input: ManualTokenDeployInput) => client.deployToken(input);
export const getLpPositions = () => client.getLpPositions();
export const lookupLpPosition = (tokenAddress: string) => client.lookupLpPosition(tokenAddress);
export const addLiquidity = (input: AddLiquidityInput) => client.addLiquidity(input);
export const removeLiquidity = (input: { poolAddress: string } | { tokenAddress: string }) =>
  client.removeLiquidity(input);
export const getLaunchWorkflows = () => client.getLaunchWorkflows();
export const getLaunchWorkflow = (workflowId: string) => client.getLaunchWorkflow(workflowId);
export const startLaunchWorkflow = (input: LaunchWorkflowInput) => client.startLaunchWorkflow(input);
export const cancelLaunchWorkflow = (workflowId: string) => client.cancelLaunchWorkflow(workflowId);
export const depositLaunchWorkflow = (workflowId: string) => client.depositLaunchWorkflow(workflowId);
export const getGmailStatus = () => client.getGmailStatus();
export const getGmailAccounts = () => client.getGmailAccounts();
export const getGmailMessages = (accountId?: string) => client.getGmailMessages(accountId);
export const getGmailConnectUrl = () => client.getGmailConnectUrl();
export const syncGmailAccounts = () => client.syncGmailAccounts();
export const syncGmailAccount = (accountId: string) => client.syncGmailAccount(accountId);
export const setDefaultGmailAccount = (accountId: string) => client.setDefaultGmailAccount(accountId);
export const disconnectGmailAccount = (accountId: string) => client.disconnectGmailAccount(accountId);
