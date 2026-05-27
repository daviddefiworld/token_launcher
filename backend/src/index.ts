import './env';
import cors from 'cors';
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { Server, Socket } from 'socket.io';
import { gmailRouter } from './gmail/routes';
import { startGmailSyncLoop } from './gmail/service';
import { buildActivityFeed } from './activity';
import {
  completeOrder,
  createOrder,
  getOrder,
  listOrders,
  markOrderExecuting,
  updateOrder,
  type AutomationOrder,
  type WithdrawRequest
} from './orders/store';
import { verificationRequestsRouter } from './verification-requests/routes';
import { generateAuthenticatorCode } from './authenticator';
import { setVerificationSocketServer, startVerificationCodeRequest } from './verification-requests/service';

type OrderStatus = AutomationOrder['status'];

interface ExtensionRecord {
  extensionId: string;
  socketId: string;
  connectedAt: string;
  lastSeen: string;
  isOnline: boolean;
  currentUrl?: string;
  userAgent?: string;
  version?: string;
}

const PORT = Number(process.env.PORT || 5050);
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const extensions = new Map<string, ExtensionRecord>();
const dashboardSockets = new Set<string>();

app.use(cors());
app.use(express.json());

function nowIso(): string {
  return new Date().toISOString();
}

function listExtensions(): ExtensionRecord[] {
  return [...extensions.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function broadcastExtensionList(): void {
  io.to('dashboards').emit('extensions:updated', { extensions: listExtensions() });
}

function broadcastOrder(order: AutomationOrder): void {
  io.to('dashboards').emit('orders:updated', { order });
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | undefined {
  const trimmed = readString(value);
  return trimmed || undefined;
}

function readWithdrawRequest(body: unknown): WithdrawRequest {
  const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const input = source.input && typeof source.input === 'object' ? (source.input as Record<string, unknown>) : source;
  const currency = readString(input.currency) || 'ETH';
  const chain = readString(input.chain) || 'base';
  const address = readString(input.address);
  const amount = readString(input.amount);

  if (!address) {
    throw new Error('address is required');
  }
  if (!amount) {
    throw new Error('amount is required');
  }

  return {
    text: readString(input.text) || `${currency} withdraw on ${chain}`,
    currency,
    chain,
    address,
    amount,
    emailCode: readOptionalString(input.emailCode),
    authenticatorCode: readOptionalString(input.authenticatorCode)
  };
}

function createOrderForExtension(extensionId: string, input: WithdrawRequest): AutomationOrder {
  return createOrder(extensionId, input);
}

function sendOrderToExtension(order: AutomationOrder): boolean {
  const extension = extensions.get(order.extensionId);
  if (!extension) return false;

  const socket = io.sockets.sockets.get(extension.socketId);
  if (!socket) {
    extensions.delete(order.extensionId);
    broadcastExtensionList();
    return false;
  }

  const updated = markOrderExecuting(order.orderId);
  if (!updated) return false;

  socket.emit('extension:run_order', {
    orderId: updated.orderId,
    ...updated.input
  });
  broadcastOrder(updated);
  return true;
}

function handleCreateOrder(extensionId: string, input: WithdrawRequest, res?: Response): AutomationOrder | null {
  const trimmedExtensionId = extensionId.trim();
  const extension = extensions.get(trimmedExtensionId);
  if (!extension) {
    res?.status(404).json({
      success: false,
      error: `Extension ${trimmedExtensionId} is not connected`
    });
    return null;
  }

  const order = createOrderForExtension(trimmedExtensionId, input);
  const sent = sendOrderToExtension(order);
  if (!sent) {
    const failed = updateOrder(order.orderId, {
      status: 'failed',
      error: 'Extension disconnected before order could run'
    });
    if (failed) broadcastOrder(failed);
    res?.status(409).json({ success: false, error: 'Extension disconnected before order could run', data: failed });
    return null;
  }

  io.to('dashboards').emit('orders:created', { order: getOrder(order.orderId) });
  const created = getOrder(order.orderId);
  res?.status(201).json({ success: true, data: created });
  return created || order;
}

app.get('/health', (_req, res) => {
  res.json({ success: true, status: 'ok', service: 'token-automation-backend' });
});

app.get('/api/extensions', (_req, res) => {
  res.json({ success: true, data: listExtensions() });
});

app.get('/api/orders', (req, res) => {
  const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
  res.json({ success: true, data: listOrders(extensionId) });
});

app.get('/api/activity', (req, res) => {
  const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
  res.json({ success: true, data: buildActivityFeed(listOrders(), extensionId) });
});

app.get('/api/orders/:orderId', (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) {
    res.status(404).json({ success: false, error: 'Order not found' });
    return;
  }
  res.json({ success: true, data: order });
});

app.use('/api/gmails', gmailRouter);
app.use('/api/verification-requests', verificationRequestsRouter);

app.post('/api/extensions/:extensionId/orders', (req: Request, res: Response) => {
  try {
    handleCreateOrder(req.params.extensionId, readWithdrawRequest(req.body), res);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid withdraw request';
    res.status(400).json({ success: false, error: message });
  }
});

io.on('connection', (socket: Socket) => {
  socket.on('dashboard:connect', () => {
    dashboardSockets.add(socket.id);
    socket.join('dashboards');
    socket.emit('dashboard:connected', {
      socketId: socket.id,
      extensions: listExtensions(),
      orders: listOrders(),
      activity: buildActivityFeed(listOrders())
    });
  });

  socket.on(
    'dashboard:create_order',
    (
      data: { extensionId?: string; input?: Partial<WithdrawRequest> } & Partial<WithdrawRequest>,
      ack?: (response: { success: boolean; order?: AutomationOrder; error?: string }) => void
    ) => {
      const extensionId = data.extensionId?.trim();
      if (!extensionId) {
        ack?.({ success: false, error: 'extensionId is required' });
        return;
      }
      let input: WithdrawRequest;
      try {
        input = readWithdrawRequest(data.input ?? data);
      } catch (error) {
        ack?.({ success: false, error: error instanceof Error ? error.message : 'Invalid withdraw request' });
        return;
      }
      const order = handleCreateOrder(extensionId, input);
      if (!order) {
        ack?.({ success: false, error: `Extension ${extensionId} is not connected` });
        return;
      }
      ack?.({ success: true, order });
    }
  );

  socket.on(
    'extension:connect',
    (data: { extensionId?: string; currentUrl?: string; userAgent?: string; version?: string }) => {
      const extensionId = data.extensionId?.trim() || `token-ext-${randomUUID()}`;
      const record: ExtensionRecord = {
        extensionId,
        socketId: socket.id,
        connectedAt: nowIso(),
        lastSeen: nowIso(),
        isOnline: true,
        currentUrl: data.currentUrl,
        userAgent: data.userAgent,
        version: data.version
      };
      extensions.set(extensionId, record);
      socket.data.extensionId = extensionId;
      socket.emit('extension:connected', { extensionId });
      broadcastExtensionList();
    }
  );

  socket.on('extension:status_update', (data: { currentUrl?: string }) => {
    const extensionId = typeof socket.data.extensionId === 'string' ? socket.data.extensionId : '';
    const record = extensions.get(extensionId);
    if (!record) return;
    record.lastSeen = nowIso();
    record.isOnline = true;
    if (data.currentUrl) {
      record.currentUrl = data.currentUrl;
    }
    broadcastExtensionList();
  });

  socket.on(
    'extension:request_authenticator_code',
    (ack?: (response: { success: boolean; authenticatorCode?: string; error?: string }) => void) => {
      const extensionId = typeof socket.data.extensionId === 'string' ? socket.data.extensionId : '';
      if (!extensionId) {
        ack?.({ success: false, error: 'Extension is not registered' });
        return;
      }

      try {
        ack?.({ success: true, authenticatorCode: generateAuthenticatorCode() });
      } catch (error) {
        ack?.({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to generate authenticator code'
        });
      }
    }
  );

  socket.on(
    'extension:request_verification_code',
    (
      data: { orderId?: string; emailCodeSentAt?: number },
      ack?: (response: { success: boolean; requestId?: string; error?: string }) => void
    ) => {
      const extensionId = typeof socket.data.extensionId === 'string' ? socket.data.extensionId : '';
      const orderId = data.orderId?.trim();
      const emailCodeSentAt = Number(data.emailCodeSentAt);

      if (!extensionId) {
        ack?.({ success: false, error: 'Extension is not registered' });
        return;
      }
      if (!orderId) {
        ack?.({ success: false, error: 'orderId is required' });
        return;
      }
      if (!Number.isFinite(emailCodeSentAt)) {
        ack?.({ success: false, error: 'emailCodeSentAt is required' });
        return;
      }

      const request = startVerificationCodeRequest({ orderId, extensionId, emailCodeSentAt });
      ack?.({ success: true, requestId: request.requestId });
    }
  );

  socket.on(
    'extension:order_result',
    (data: {
      orderId?: string;
      status?: OrderStatus;
      error?: string;
      output?: AutomationOrder['output'];
    }) => {
      if (!data.orderId) return;
      const status = data.status === 'failed' ? 'failed' : 'completed';
      const order = completeOrder(data.orderId, {
        status,
        output: data.output,
        error: data.error
      });
      if (!order) return;
      broadcastOrder(order);
    }
  );

  socket.on('disconnect', () => {
    dashboardSockets.delete(socket.id);

    for (const [extensionId, record] of extensions.entries()) {
      if (record.socketId === socket.id) {
        extensions.delete(extensionId);
        broadcastExtensionList();
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  setVerificationSocketServer(io);
  startGmailSyncLoop();
  console.log(`Token automation backend listening on http://localhost:${PORT}`);
});
