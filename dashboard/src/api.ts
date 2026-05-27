import type {
  ActivityItem,
  AutomationOrder,
  CachedGmailMessage,
  ExtensionRecord,
  GmailAccount,
  GmailStatus
} from './types';

const API_BASE_URL = import.meta.env.VITE_TOKEN_BACKEND_URL || 'http://localhost:5050';

export interface WithdrawOrderInput {
  currency: string;
  chain: string;
  address: string;
  amount: string;
  emailCode?: string;
  authenticatorCode?: string;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers
    }
  });
  const body = (await response.json()) as { success: boolean; data?: T; error?: string };
  if (!response.ok || !body.success) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body.data as T;
}

export function getBackendUrl(): string {
  return API_BASE_URL;
}

export function getExtensions(): Promise<ExtensionRecord[]> {
  return readJson<ExtensionRecord[]>(`${API_BASE_URL}/api/extensions`);
}

export function getOrders(extensionId?: string): Promise<AutomationOrder[]> {
  const params = extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : '';
  return readJson<AutomationOrder[]>(`${API_BASE_URL}/api/orders${params}`);
}

export function getActivity(extensionId?: string): Promise<ActivityItem[]> {
  const params = extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : '';
  return readJson<ActivityItem[]>(`${API_BASE_URL}/api/activity${params}`);
}

export function createOrder(extensionId: string, input: WithdrawOrderInput): Promise<AutomationOrder> {
  return readJson<AutomationOrder>(`${API_BASE_URL}/api/extensions/${encodeURIComponent(extensionId)}/orders`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function getGmailStatus(): Promise<GmailStatus> {
  return readJson<GmailStatus>(`${API_BASE_URL}/api/gmails/status`);
}

export function getGmailAccounts(): Promise<GmailAccount[]> {
  return readJson<GmailAccount[]>(`${API_BASE_URL}/api/gmails`);
}

export function getGmailMessages(accountId?: string): Promise<CachedGmailMessage[]> {
  const params = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
  return readJson<CachedGmailMessage[]>(`${API_BASE_URL}/api/gmails/messages${params}`);
}

export async function getGmailConnectUrl(): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/gmails/connect-url`);
  const body = (await response.json()) as { success: boolean; data?: { url: string }; error?: string };
  if (!response.ok || !body.success || !body.data?.url) {
    throw new Error(body.error || 'Could not start Gmail connection');
  }
  return body.data.url;
}

export function syncGmailAccounts(): Promise<GmailAccount[]> {
  return readJson<GmailAccount[]>(`${API_BASE_URL}/api/gmails/sync`, { method: 'POST' });
}

export function syncGmailAccount(accountId: string): Promise<GmailAccount> {
  return readJson<GmailAccount>(`${API_BASE_URL}/api/gmails/${encodeURIComponent(accountId)}/sync`, { method: 'POST' });
}

export function setDefaultGmailAccount(accountId: string): Promise<GmailAccount> {
  return readJson<GmailAccount>(`${API_BASE_URL}/api/gmails/${encodeURIComponent(accountId)}/default`, { method: 'POST' });
}

export async function disconnectGmailAccount(accountId: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/gmails/${encodeURIComponent(accountId)}`, { method: 'DELETE' });
  const body = (await response.json()) as { success: boolean; error?: string };
  if (!response.ok || !body.success) {
    throw new Error(body.error || 'Could not disconnect Gmail account');
  }
}
