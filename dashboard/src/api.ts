import type {
  ActivityItem,
  AutomationOrder,
  CachedGmailMessage,
  ExtensionRecord,
  GmailAccount,
  GmailStatus
} from './types';

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
export const getGmailStatus = () => client.getGmailStatus();
export const getGmailAccounts = () => client.getGmailAccounts();
export const getGmailMessages = (accountId?: string) => client.getGmailMessages(accountId);
export const getGmailConnectUrl = () => client.getGmailConnectUrl();
export const syncGmailAccounts = () => client.syncGmailAccounts();
export const syncGmailAccount = (accountId: string) => client.syncGmailAccount(accountId);
export const setDefaultGmailAccount = (accountId: string) => client.setDefaultGmailAccount(accountId);
export const disconnectGmailAccount = (accountId: string) => client.disconnectGmailAccount(accountId);
