import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  AutomationOrder,
  CachedGmailMessage,
  GmailAccount,
  GmailStoreSnapshot,
  UsedGmailMessage,
  VerificationCodeRequest,
  WithdrawRequest
} from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
export const GMAIL_RECENT_LIMIT = 5;
export const ORDER_TIMEOUT_MS = 5 * 60 * 1000;

export function nowIso(): string {
  return new Date().toISOString();
}

function orderStartedAtMs(order: AutomationOrder): number {
  return new Date(order.executingAt ?? order.createdAt).getTime();
}

class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  read(defaultValue: T): T {
    if (!existsSync(this.filePath)) return defaultValue;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as T;
    } catch {
      return defaultValue;
    }
  }

  write(data: T): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }
}

function sortMessages(messages: CachedGmailMessage[]): CachedGmailMessage[] {
  return [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, GMAIL_RECENT_LIMIT);
}

export class OrderRepository {
  private readonly orders = new Map<string, AutomationOrder>();
  private readonly file = new JsonFileStore<AutomationOrder[]>(path.join(DATA_DIR, 'orders.json'));

  constructor() {
    this.file.read([]).forEach((order) => {
      if (order?.orderId) this.orders.set(order.orderId, order);
    });
  }

  private persist(): void {
    this.file.write([...this.orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }

  list(extensionId?: string): AutomationOrder[] {
    const all = [...this.orders.values()];
    const filtered = extensionId ? all.filter((o) => o.extensionId === extensionId) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(orderId: string): AutomationOrder | undefined {
    return this.orders.get(orderId);
  }

  findActiveForExtension(extensionId: string): AutomationOrder | undefined {
    return [...this.orders.values()].find(
      (order) => order.extensionId === extensionId && (order.status === 'pending' || order.status === 'executing')
    );
  }

  expireStaleOrders(timeoutMs: number = ORDER_TIMEOUT_MS): AutomationOrder[] {
    const now = Date.now();
    const expired: AutomationOrder[] = [];
    for (const order of this.orders.values()) {
      if (order.status !== 'pending' && order.status !== 'executing') continue;
      const startedAt = orderStartedAtMs(order);
      if (!Number.isFinite(startedAt) || now - startedAt < timeoutMs) continue;
      const failed = this.complete(order.orderId, {
        status: 'failed',
        error: 'Order timed out after 5 minutes'
      });
      if (failed) expired.push(failed);
    }
    return expired;
  }

  create(extensionId: string, input: WithdrawRequest): AutomationOrder {
    const order: AutomationOrder = {
      orderId: randomUUID(),
      extensionId,
      status: 'pending',
      input,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.orders.set(order.orderId, order);
    this.persist();
    return order;
  }

  markExecuting(orderId: string): AutomationOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: AutomationOrder = { ...order, status: 'executing', executingAt: nowIso(), updatedAt: nowIso() };
    this.orders.set(orderId, updated);
    this.persist();
    return updated;
  }

  complete(
    orderId: string,
    patch: { status: 'completed' | 'failed'; output?: AutomationOrder['output']; error?: string }
  ): AutomationOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    if (order.status === 'completed' || order.status === 'failed') return order;
    const finishedAt = Date.now();
    const executingAtMs = order.executingAt ? new Date(order.executingAt).getTime() : undefined;
    const executeTimeMs =
      executingAtMs !== undefined && Number.isFinite(executingAtMs) ? Math.max(0, finishedAt - executingAtMs) : undefined;
    const completedAt = patch.output?.completedAt ?? nowIso();
    const output = patch.output ? { ...patch.output, completedAt } : { completedAt };
    const updated: AutomationOrder = { ...order, ...patch, output, executeTimeMs, updatedAt: nowIso() };
    this.orders.set(orderId, updated);
    this.persist();
    return updated;
  }

  update(orderId: string, patch: Partial<AutomationOrder>): AutomationOrder | null {
    const order = this.orders.get(orderId);
    if (!order) return null;
    const updated: AutomationOrder = { ...order, ...patch, orderId: order.orderId, updatedAt: nowIso() };
    this.orders.set(orderId, updated);
    this.persist();
    return updated;
  }
}

export class VerificationRepository {
  private readonly requests = new Map<string, VerificationCodeRequest>();

  create(input: { orderId: string; extensionId: string; emailCodeSentAt: number }): VerificationCodeRequest {
    const request: VerificationCodeRequest = {
      requestId: randomUUID(),
      orderId: input.orderId,
      extensionId: input.extensionId,
      emailCodeSentAt: input.emailCodeSentAt,
      status: 'pending',
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.requests.set(request.requestId, request);
    return request;
  }

  get(requestId: string): VerificationCodeRequest | undefined {
    return this.requests.get(requestId);
  }

  update(
    requestId: string,
    patch: Partial<Pick<VerificationCodeRequest, 'status' | 'emailCode' | 'gmailAccountId' | 'gmailMessageId' | 'error'>>
  ): VerificationCodeRequest | null {
    const existing = this.requests.get(requestId);
    if (!existing) return null;
    const updated: VerificationCodeRequest = { ...existing, ...patch, requestId: existing.requestId, updatedAt: nowIso() };
    this.requests.set(requestId, updated);
    return updated;
  }

  list(extensionId?: string): VerificationCodeRequest[] {
    const all = [...this.requests.values()];
    const filtered = extensionId ? all.filter((r) => r.extensionId === extensionId) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class GmailRepository {
  private accounts: GmailAccount[] = [];
  private defaultAccountId?: string;
  private readonly messagesByAccount = new Map<string, CachedGmailMessage[]>();
  private readonly usedMessages = new Map<string, UsedGmailMessage>();
  private readonly file = new JsonFileStore<GmailStoreSnapshot>(path.join(DATA_DIR, 'gmail-accounts.json'));

  constructor() {
    const snapshot = this.file.read({ accounts: [] });
    this.accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
    this.defaultAccountId = snapshot.defaultAccountId;
    if (Array.isArray(snapshot.usedMessages)) {
      snapshot.usedMessages.forEach((entry) => {
        if (entry?.accountId && entry?.messageId) {
          this.usedMessages.set(this.usedKey(entry.accountId, entry.messageId), entry);
        }
      });
    }
  }

  private usedKey(accountId: string, messageId: string): string {
    return `${accountId}:${messageId}`;
  }

  private persist(): void {
    this.file.write({
      accounts: this.accounts.map((a) => ({ ...a, tokens: { ...a.tokens } })),
      defaultAccountId: this.defaultAccountId,
      usedMessages: [...this.usedMessages.values()].sort((a, b) => b.usedAt.localeCompare(a.usedAt))
    });
  }

  listAccounts(): GmailAccount[] {
    return [...this.accounts].sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
  }

  getAccount(accountId: string): GmailAccount | undefined {
    return this.accounts.find((a) => a.id === accountId);
  }

  getDefaultAccount(): GmailAccount | undefined {
    if (this.defaultAccountId) {
      const selected = this.getAccount(this.defaultAccountId);
      if (selected) return selected;
    }
    return this.accounts[0];
  }

  upsertAccount(account: GmailAccount): GmailAccount {
    const index = this.accounts.findIndex((a) => a.id === account.id);
    if (index === -1) {
      if (this.accounts.length === 0) {
        account.isDefault = true;
        this.defaultAccountId = account.id;
      }
      this.accounts.push(account);
    } else {
      this.accounts[index] = account;
    }
    if (account.isDefault) {
      this.defaultAccountId = account.id;
      this.accounts = this.accounts.map((a) => ({ ...a, isDefault: a.id === account.id }));
    }
    this.persist();
    return account;
  }

  removeAccount(accountId: string): boolean {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== accountId);
    this.messagesByAccount.delete(accountId);
    if (this.defaultAccountId === accountId) {
      this.defaultAccountId = this.accounts[0]?.id;
      if (this.accounts[0]) this.accounts[0] = { ...this.accounts[0], isDefault: true };
    }
    this.persist();
    return this.accounts.length < before;
  }

  setDefault(accountId: string): GmailAccount | null {
    if (!this.getAccount(accountId)) return null;
    this.accounts = this.accounts.map((a) => ({ ...a, isDefault: a.id === accountId }));
    this.defaultAccountId = accountId;
    this.persist();
    return this.getAccount(accountId) || null;
  }

  updateAccount(accountId: string, patch: Partial<GmailAccount>): GmailAccount | null {
    const account = this.getAccount(accountId);
    if (!account) return null;
    const updated: GmailAccount = {
      ...account,
      ...patch,
      id: account.id,
      tokens: patch.tokens ? { ...account.tokens, ...patch.tokens } : account.tokens
    };
    return this.upsertAccount(updated);
  }

  listMessages(accountId?: string): CachedGmailMessage[] {
    if (accountId) return sortMessages(this.messagesByAccount.get(accountId) || []);
    return sortMessages([...this.messagesByAccount.values()].flat());
  }

  replaceMessages(accountId: string, messages: CachedGmailMessage[]): void {
    this.messagesByAccount.set(accountId, sortMessages(messages));
  }

  appendMessages(accountId: string, incoming: CachedGmailMessage[]): void {
    const merged = new Map<string, CachedGmailMessage>();
    [...incoming, ...(this.messagesByAccount.get(accountId) || [])].forEach((m) => merged.set(m.id, m));
    this.messagesByAccount.set(accountId, sortMessages([...merged.values()]));
  }

  publicView(account: GmailAccount): Omit<GmailAccount, 'tokens'> {
    const { tokens: _tokens, ...rest } = account;
    return rest;
  }

  isMessageUsed(accountId: string, messageId: string): boolean {
    return this.usedMessages.has(this.usedKey(accountId, messageId));
  }

  markMessageUsed(input: { accountId: string; messageId: string; orderId?: string }): void {
    const key = this.usedKey(input.accountId, input.messageId);
    if (this.usedMessages.has(key)) return;
    this.usedMessages.set(key, {
      accountId: input.accountId,
      messageId: input.messageId,
      usedAt: nowIso(),
      orderId: input.orderId
    });
    this.persist();
  }
}
