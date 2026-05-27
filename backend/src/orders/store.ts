import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

export type OrderStatus = 'pending' | 'executing' | 'completed' | 'failed';

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

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'orders.json');

const orders = new Map<string, AutomationOrder>();

function nowIso(): string {
  return new Date().toISOString();
}

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const snapshot = [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  writeFileSync(STORE_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
}

function load(): void {
  if (!existsSync(STORE_PATH)) {
    orders.clear();
    return;
  }

  try {
    const raw = readFileSync(STORE_PATH, 'utf8');
    const snapshot = JSON.parse(raw) as AutomationOrder[];
    orders.clear();
    if (Array.isArray(snapshot)) {
      snapshot.forEach((order) => {
        if (order?.orderId) {
          orders.set(order.orderId, order);
        }
      });
    }
  } catch {
    orders.clear();
  }
}

load();

export function listOrders(extensionId?: string): AutomationOrder[] {
  const all = [...orders.values()];
  const filtered = extensionId ? all.filter((order) => order.extensionId === extensionId) : all;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getOrder(orderId: string): AutomationOrder | undefined {
  return orders.get(orderId);
}

export function createOrder(extensionId: string, input: WithdrawRequest): AutomationOrder {
  const order: AutomationOrder = {
    orderId: randomUUID(),
    extensionId,
    status: 'pending',
    input,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  orders.set(order.orderId, order);
  persist();
  return order;
}

export function markOrderExecuting(orderId: string): AutomationOrder | null {
  const order = orders.get(orderId);
  if (!order) return null;
  const updated: AutomationOrder = {
    ...order,
    status: 'executing',
    executingAt: nowIso(),
    updatedAt: nowIso()
  };
  orders.set(orderId, updated);
  persist();
  return updated;
}

export function completeOrder(
  orderId: string,
  patch: {
    status: 'completed' | 'failed';
    output?: AutomationOrder['output'];
    error?: string;
  }
): AutomationOrder | null {
  const order = orders.get(orderId);
  if (!order) return null;

  const finishedAt = Date.now();
  const executingAtMs = order.executingAt ? new Date(order.executingAt).getTime() : undefined;
  const executeTimeMs =
    executingAtMs !== undefined && Number.isFinite(executingAtMs)
      ? Math.max(0, finishedAt - executingAtMs)
      : undefined;

  const updated: AutomationOrder = {
    ...order,
    status: patch.status,
    output: patch.output,
    error: patch.error,
    executeTimeMs,
    updatedAt: nowIso()
  };
  orders.set(orderId, updated);
  persist();
  return updated;
}

export function updateOrder(orderId: string, patch: Partial<AutomationOrder>): AutomationOrder | null {
  const order = orders.get(orderId);
  if (!order) return null;
  const updated: AutomationOrder = {
    ...order,
    ...patch,
    orderId: order.orderId,
    updatedAt: nowIso()
  };
  orders.set(orderId, updated);
  persist();
  return updated;
}
