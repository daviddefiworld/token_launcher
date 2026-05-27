import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { CachedGmailMessage, GmailAccount, GmailStoreSnapshot, UsedGmailMessage } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'gmail-accounts.json');
export const RECENT_MESSAGES_LIMIT = 5;

function sortAndLimit(messages: CachedGmailMessage[]): CachedGmailMessage[] {
  return [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, RECENT_MESSAGES_LIMIT);
}

let accounts: GmailAccount[] = [];
let defaultAccountId: string | undefined;
const messagesByAccount = new Map<string, CachedGmailMessage[]>();
const usedMessages = new Map<string, UsedGmailMessage>();

function usedMessageKey(accountId: string, messageId: string): string {
  return `${accountId}:${messageId}`;
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const snapshot: GmailStoreSnapshot = {
    accounts: accounts.map((account) => ({
      ...account,
      tokens: { ...account.tokens }
    })),
    defaultAccountId,
    usedMessages: [...usedMessages.values()].sort((a, b) => b.usedAt.localeCompare(a.usedAt))
  };
  writeFileSync(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

function load(): void {
  if (!existsSync(STORE_PATH)) {
    accounts = [];
    defaultAccountId = undefined;
    return;
  }

  try {
    const raw = readFileSync(STORE_PATH, 'utf8');
    const snapshot = JSON.parse(raw) as GmailStoreSnapshot;
    accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    defaultAccountId = snapshot.defaultAccountId;
    messagesByAccount.clear();
    usedMessages.clear();
    if (Array.isArray(snapshot.usedMessages)) {
      snapshot.usedMessages.forEach((entry) => {
        if (entry?.accountId && entry?.messageId) {
          usedMessages.set(usedMessageKey(entry.accountId, entry.messageId), entry);
        }
      });
    }
  } catch {
    accounts = [];
    defaultAccountId = undefined;
  }
}

load();

export function listGmailAccounts(): GmailAccount[] {
  return [...accounts].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

export function getGmailAccount(accountId: string): GmailAccount | undefined {
  return accounts.find((account) => account.id === accountId);
}

export function getDefaultGmailAccount(): GmailAccount | undefined {
  if (defaultAccountId) {
    const selected = getGmailAccount(defaultAccountId);
    if (selected) return selected;
  }
  return accounts[0];
}

export function upsertGmailAccount(account: GmailAccount): GmailAccount {
  const index = accounts.findIndex((item) => item.id === account.id);
  if (index === -1) {
    if (accounts.length === 0) {
      account.isDefault = true;
      defaultAccountId = account.id;
    }
    accounts.push(account);
  } else {
    accounts[index] = account;
  }
  if (account.isDefault) {
    defaultAccountId = account.id;
    accounts = accounts.map((item) => ({ ...item, isDefault: item.id === account.id }));
  }
  persist();
  return account;
}

export function removeGmailAccount(accountId: string): boolean {
  const before = accounts.length;
  accounts = accounts.filter((account) => account.id !== accountId);
  messagesByAccount.delete(accountId);
  if (defaultAccountId === accountId) {
    defaultAccountId = accounts[0]?.id;
    if (accounts[0]) {
      accounts[0] = { ...accounts[0], isDefault: true };
    }
  }
  persist();
  return accounts.length < before;
}

export function setDefaultGmailAccount(accountId: string): GmailAccount | null {
  const account = getGmailAccount(accountId);
  if (!account) return null;
  accounts = accounts.map((item) => ({ ...item, isDefault: item.id === accountId }));
  defaultAccountId = accountId;
  persist();
  return getGmailAccount(accountId) || null;
}

export function updateGmailAccount(accountId: string, patch: Partial<GmailAccount>): GmailAccount | null {
  const account = getGmailAccount(accountId);
  if (!account) return null;
  const updated = { ...account, ...patch, id: account.id, tokens: patch.tokens ? { ...account.tokens, ...patch.tokens } : account.tokens };
  return upsertGmailAccount(updated);
}

export function listCachedMessages(accountId?: string): CachedGmailMessage[] {
  if (accountId) {
    return sortAndLimit(messagesByAccount.get(accountId) || []);
  }
  return sortAndLimit([...messagesByAccount.values()].flat());
}

export function replaceCachedMessages(accountId: string, messages: CachedGmailMessage[]): void {
  messagesByAccount.set(accountId, sortAndLimit(messages));
}

export function appendCachedMessages(accountId: string, incoming: CachedGmailMessage[]): void {
  const existing = messagesByAccount.get(accountId) || [];
  const merged = new Map<string, CachedGmailMessage>();
  [...incoming, ...existing].forEach((message) => merged.set(message.id, message));
  messagesByAccount.set(accountId, sortAndLimit([...merged.values()]));
}

export function publicAccountView(account: GmailAccount): Omit<GmailAccount, 'tokens'> {
  const { tokens: _tokens, ...rest } = account;
  return rest;
}

export function isMessageUsed(accountId: string, messageId: string): boolean {
  return usedMessages.has(usedMessageKey(accountId, messageId));
}

export function markMessageUsed(input: { accountId: string; messageId: string; orderId?: string }): void {
  const key = usedMessageKey(input.accountId, input.messageId);
  if (usedMessages.has(key)) return;
  usedMessages.set(key, {
    accountId: input.accountId,
    messageId: input.messageId,
    usedAt: new Date().toISOString(),
    orderId: input.orderId
  });
  persist();
}

export function listUsedMessages(): UsedGmailMessage[] {
  return [...usedMessages.values()].sort((a, b) => b.usedAt.localeCompare(a.usedAt));
}
