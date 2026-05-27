import cors from 'cors';
import { createHmac } from 'crypto';
import { randomUUID } from 'crypto';
import express, { Request, Response, Router } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { GmailService } from './gmail';
import { GmailRepository, OrderRepository, VerificationRepository, nowIso } from './persist';
import type {
  ActivityItem,
  AutomationOrder,
  ExtensionRecord,
  VerificationCodeRequest,
  WithdrawRequest
} from './types';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PORT = Number(process.env.PORT || 5050);

class TotpAuthenticator {
  generate(): string {
    const secret = process.env.GOOGLE_AUTHENTICATOR_SECRET?.trim();
    if (!secret) throw new Error('GOOGLE_AUTHENTICATOR_SECRET is not configured in backend/.env');
    return TotpAuthenticator.code(secret);
  }

  private static code(secret: string, timestampMs = Date.now(), stepSeconds = 30): string {
    const key = TotpAuthenticator.decodeSecret(secret.trim().replace(/^secret=/i, ''));
    const counter = Math.floor(timestampMs / 1000 / stepSeconds);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buffer.writeUInt32BE(counter % 0x100000000, 4);
    const hmac = createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);
    return (binary % 1_000_000).toString().padStart(6, '0');
  }

  private static decodeSecret(secret: string): Buffer {
    const cleaned = secret.replace(/=+$/g, '').replace(/\s+/g, '').toUpperCase();
    let bits = '';
    for (const char of cleaned) {
      const value = BASE32.indexOf(char);
      if (value === -1) throw new Error('Invalid authenticator secret');
      bits += value.toString(2).padStart(5, '0');
    }
    const bytes: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
  }
}

class ActivityFeed {
  constructor(private readonly verification: VerificationRepository) {}

  build(orders: AutomationOrder[], extensionId?: string): ActivityItem[] {
    const verification = this.verification.list(extensionId);
    const items: ActivityItem[] = [
      ...orders
        .filter((o) => !extensionId || o.extensionId === extensionId)
        .map((o) => ActivityFeed.fromOrder(o)),
      ...verification.map((r) => ActivityFeed.fromVerification(r))
    ];
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private static fromOrder(order: AutomationOrder): ActivityItem {
    return {
      id: order.orderId,
      kind: 'withdraw',
      extensionId: order.extensionId,
      status: order.status,
      title: order.input.text,
      summary: `${order.input.amount} ${order.input.currency} on ${order.input.chain} → ${order.input.address}`,
      withdraw: {
        currency: order.input.currency,
        chain: order.input.chain,
        address: order.input.address,
        amount: order.input.amount,
        text: order.input.text
      },
      error: order.error,
      message: order.output?.message,
      pageUrl: order.output?.pageUrl,
      executeTimeMs: order.executeTimeMs,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt
    };
  }

  private static fromVerification(request: VerificationCodeRequest): ActivityItem {
    const sentLabel = new Date(request.emailCodeSentAt).toISOString();
    return {
      id: request.requestId,
      kind: 'email_verification',
      extensionId: request.extensionId,
      status: request.status,
      title: 'Gmail verification code',
      summary: `Withdraw order ${request.orderId.slice(0, 8)}… · after ${sentLabel}`,
      parentOrderId: request.orderId,
      emailCode: request.emailCode,
      emailCodeSentAt: request.emailCodeSentAt,
      error: request.error,
      message: request.status === 'completed' ? `Code ${request.emailCode}` : undefined,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt
    };
  }
}

class WithdrawInputParser {
  static parse(body: unknown): WithdrawRequest {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const input = source.input && typeof source.input === 'object' ? (source.input as Record<string, unknown>) : source;
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const opt = (v: unknown) => {
      const t = str(v);
      return t || undefined;
    };
    const currency = str(input.currency) || 'ETH';
    const chain = str(input.chain) || 'base';
    const address = str(input.address);
    const amount = str(input.amount);
    if (!address) throw new Error('address is required');
    if (!amount) throw new Error('amount is required');
    return {
      text: str(input.text) || `${currency} withdraw on ${chain}`,
      currency,
      chain,
      address,
      amount,
      emailCode: opt(input.emailCode),
      authenticatorCode: opt(input.authenticatorCode)
    };
  }
}

export class TokenAutomationApp {
  private readonly orders = new OrderRepository();
  private readonly gmailStore = new GmailRepository();
  private readonly verificationStore = new VerificationRepository();
  private readonly gmail = new GmailService(this.gmailStore);
  private readonly activity = new ActivityFeed(this.verificationStore);
  private readonly totp = new TotpAuthenticator();
  private readonly extensions = new Map<string, ExtensionRecord>();

  private httpServer!: HttpServer;
  private io!: Server;

  start(): void {
    const app = express();
    this.httpServer = createServer(app);
    this.io = new Server(this.httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

    app.use(cors());
    app.use(express.json());
    app.get('/health', (_req, res) => {
      res.json({ success: true, status: 'ok', service: 'token-automation-backend' });
    });
    app.use('/api/gmails', this.gmailRoutes());
    app.use('/api/verification-requests', this.verificationRoutes());
    this.coreRoutes(app);

    this.io.on('connection', (socket) => this.onSocket(socket));

    this.httpServer.listen(PORT, () => {
      this.gmail.startSyncLoop();
      this.flushExpiredOrders();
      setInterval(() => this.flushExpiredOrders(), 15_000);
      console.log(`Token automation backend listening on http://localhost:${PORT}`);
    });
  }

  private flushExpiredOrders(): void {
    for (const order of this.orders.expireStaleOrders()) {
      this.broadcastOrder(order);
    }
  }

  private coreRoutes(app: express.Application): void {
    app.get('/api/extensions', (_req, res) => {
      res.json({ success: true, data: this.listExtensions() });
    });

    app.get('/api/orders', (req, res) => {
      this.flushExpiredOrders();
      const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
      res.json({ success: true, data: this.orders.list(extensionId) });
    });

    app.get('/api/activity', (req, res) => {
      this.flushExpiredOrders();
      const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
      res.json({ success: true, data: this.activity.build(this.orders.list(), extensionId) });
    });

    app.get('/api/orders/:orderId', (req, res) => {
      this.flushExpiredOrders();
      const order = this.orders.get(req.params.orderId);
      if (!order) {
        res.status(404).json({ success: false, error: 'Order not found' });
        return;
      }
      res.json({ success: true, data: order });
    });

    app.post('/api/extensions/:extensionId/orders', (req: Request, res: Response) => {
      try {
        this.createOrder(req.params.extensionId, WithdrawInputParser.parse(req.body), res);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid withdraw request';
        res.status(400).json({ success: false, error: message });
      }
    });
  }

  private gmailRoutes(): Router {
    const router = Router();
    const view = (account: ReturnType<GmailRepository['publicView']>) => account;

    router.get('/status', (_req, res) => {
      res.json({ success: true, data: { configured: this.gmail.isConfigured(), accounts: this.gmail.listPublicAccounts() } });
    });
    router.get('/', (_req, res) => res.json({ success: true, data: this.gmail.listPublicAccounts() }));
    router.get('/messages', (req, res) => {
      const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
      res.json({ success: true, data: this.gmail.listPublicMessages(accountId) });
    });
    router.get('/connect-url', (_req, res) => {
      try {
        res.json({ success: true, data: { url: this.gmail.getConnectUrl() } });
      } catch (error) {
        res.status(503).json({ success: false, error: error instanceof Error ? error.message : 'Gmail is not configured' });
      }
    });
    router.get('/oauth/callback', async (req, res) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      if (!code) {
        res.redirect(this.gmail.getDashboardRedirectUrl({ error: 'missing_code' }));
        return;
      }
      try {
        const account = await this.gmail.completeOAuth(code);
        res.redirect(this.gmail.getDashboardRedirectUrl({ connected: account.id }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OAuth failed';
        res.redirect(this.gmail.getDashboardRedirectUrl({ error: message }));
      }
    });
    router.get('/wait-for-code', async (req, res) => {
      const sentAt = Number(req.query.sentAt);
      const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : undefined;
      if (!Number.isFinite(sentAt)) {
        res.status(400).json({ success: false, error: 'sentAt query parameter is required' });
        return;
      }
      try {
        res.json({ success: true, data: await this.gmail.waitForVerificationCode(sentAt, { accountId }) });
      } catch (error) {
        res.status(504).json({ success: false, error: error instanceof Error ? error.message : 'Could not find verification code' });
      }
    });
    router.post('/sync', async (_req, res) => {
      try {
        const accounts = await this.gmail.syncAll();
        res.json({ success: true, data: accounts.map((a) => view(this.gmailStore.publicView(a))) });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Sync failed' });
      }
    });
    router.post('/:accountId/sync', async (req, res) => {
      try {
        const account = await this.gmail.syncAccount(req.params.accountId);
        res.json({ success: true, data: view(this.gmailStore.publicView(account)) });
      } catch (error) {
        res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Sync failed' });
      }
    });
    router.post('/:accountId/default', (req, res) => {
      const account = this.gmailStore.setDefault(req.params.accountId);
      if (!account) {
        res.status(404).json({ success: false, error: 'Gmail account not found' });
        return;
      }
      res.json({ success: true, data: view(this.gmailStore.publicView(account)) });
    });
    router.delete('/:accountId', (req, res) => {
      if (!this.gmailStore.removeAccount(req.params.accountId)) {
        res.status(404).json({ success: false, error: 'Gmail account not found' });
        return;
      }
      res.json({ success: true });
    });
    return router;
  }

  private verificationRoutes(): Router {
    const router = Router();
    router.post('/', (req, res) => {
      const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
      const extensionId = typeof req.body?.extensionId === 'string' ? req.body.extensionId.trim() : '';
      const emailCodeSentAt = Number(req.body?.emailCodeSentAt);
      if (!orderId) {
        res.status(400).json({ success: false, error: 'orderId is required' });
        return;
      }
      if (!extensionId) {
        res.status(400).json({ success: false, error: 'extensionId is required' });
        return;
      }
      if (!Number.isFinite(emailCodeSentAt)) {
        res.status(400).json({ success: false, error: 'emailCodeSentAt is required' });
        return;
      }
      res.status(201).json({ success: true, data: this.startVerification({ orderId, extensionId, emailCodeSentAt }) });
    });
    router.get('/:requestId', (req, res) => {
      const request = this.verificationStore.get(req.params.requestId);
      if (!request) {
        res.status(404).json({ success: false, error: 'Verification request not found' });
        return;
      }
      res.json({ success: true, data: request });
    });
    router.get('/', (req, res) => {
      const extensionId = typeof req.query.extensionId === 'string' ? req.query.extensionId : undefined;
      res.json({ success: true, data: this.verificationStore.list(extensionId) });
    });
    return router;
  }

  private onSocket(socket: Socket): void {
    socket.on('dashboard:connect', () => {
      socket.join('dashboards');
      this.flushExpiredOrders();
      socket.emit('dashboard:connected', {
        socketId: socket.id,
        extensions: this.listExtensions(),
        orders: this.orders.list(),
        activity: this.activity.build(this.orders.list())
      });
    });

    socket.on(
      'dashboard:create_order',
      (
        data: { extensionId?: string; input?: Partial<WithdrawRequest> } & Partial<WithdrawRequest>,
        ack?: (r: { success: boolean; order?: AutomationOrder; error?: string }) => void
      ) => {
        const extensionId = data.extensionId?.trim();
        if (!extensionId) {
          ack?.({ success: false, error: 'extensionId is required' });
          return;
        }
        try {
          const order = this.createOrder(extensionId, WithdrawInputParser.parse(data.input ?? data));
          if (!order) {
            ack?.({ success: false, error: `Extension ${extensionId} is not connected` });
            return;
          }
          ack?.({ success: true, order });
        } catch (error) {
          ack?.({ success: false, error: error instanceof Error ? error.message : 'Invalid withdraw request' });
        }
      }
    );

    socket.on(
      'extension:connect',
      (data: { extensionId?: string; currentUrl?: string; userAgent?: string; version?: string }) => {
        const extensionId = data.extensionId?.trim() || `token-ext-${randomUUID()}`;
        this.extensions.set(extensionId, {
          extensionId,
          socketId: socket.id,
          connectedAt: nowIso(),
          lastSeen: nowIso(),
          isOnline: true,
          currentUrl: data.currentUrl,
          userAgent: data.userAgent,
          version: data.version
        });
        socket.data.extensionId = extensionId;
        socket.emit('extension:connected', { extensionId });
        this.broadcastExtensions();
      }
    );

    socket.on('extension:status_update', (data: { currentUrl?: string }) => {
      const extensionId = typeof socket.data.extensionId === 'string' ? socket.data.extensionId : '';
      const record = this.extensions.get(extensionId);
      if (!record) return;
      record.lastSeen = nowIso();
      record.isOnline = true;
      if (data.currentUrl) record.currentUrl = data.currentUrl;
      this.broadcastExtensions();
    });

    socket.on(
      'extension:request_authenticator_code',
      (ack?: (r: { success: boolean; authenticatorCode?: string; error?: string }) => void) => {
        if (!socket.data.extensionId) {
          ack?.({ success: false, error: 'Extension is not registered' });
          return;
        }
        try {
          ack?.({ success: true, authenticatorCode: this.totp.generate() });
        } catch (error) {
          ack?.({ success: false, error: error instanceof Error ? error.message : 'Failed to generate authenticator code' });
        }
      }
    );

    socket.on(
      'extension:request_verification_code',
      (data: { orderId?: string; emailCodeSentAt?: number }, ack?: (r: { success: boolean; requestId?: string; error?: string }) => void) => {
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
        const request = this.startVerification({ orderId, extensionId, emailCodeSentAt });
        ack?.({ success: true, requestId: request.requestId });
      }
    );

    socket.on(
      'extension:order_result',
      (data: { orderId?: string; status?: AutomationOrder['status']; error?: string; output?: AutomationOrder['output'] }) => {
        if (!data.orderId) return;
        const status = data.status === 'failed' ? 'failed' : 'completed';
        const order = this.orders.complete(data.orderId, { status, output: data.output, error: data.error });
        if (order) this.broadcastOrder(order);
      }
    );

    socket.on('disconnect', () => {
      for (const [extensionId, record] of this.extensions.entries()) {
        if (record.socketId === socket.id) {
          this.extensions.delete(extensionId);
          this.broadcastExtensions();
          break;
        }
      }
    });
  }

  private listExtensions(): ExtensionRecord[] {
    return [...this.extensions.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  private broadcastExtensions(): void {
    this.io.to('dashboards').emit('extensions:updated', { extensions: this.listExtensions() });
  }

  private broadcastOrder(order: AutomationOrder): void {
    this.io.to('dashboards').emit('orders:updated', { order });
  }

  private createOrder(extensionId: string, input: WithdrawRequest, res?: Response): AutomationOrder | null {
    this.flushExpiredOrders();
    const id = extensionId.trim();
    if (!this.extensions.has(id)) {
      res?.status(404).json({ success: false, error: `Extension ${id} is not connected` });
      return null;
    }

    const active = this.orders.findActiveForExtension(id);
    if (active) {
      const message = 'Extension already has a running order';
      res?.status(409).json({ success: false, error: message });
      if (!res) throw new Error(message);
      return null;
    }

    const order = this.orders.create(id, input);
    const extension = this.extensions.get(id)!;
    const socket = this.io.sockets.sockets.get(extension.socketId);
    if (!socket) {
      this.extensions.delete(id);
      this.broadcastExtensions();
      const failed = this.orders.update(order.orderId, {
        status: 'failed',
        error: 'Extension disconnected before order could run'
      });
      if (failed) this.broadcastOrder(failed);
      res?.status(409).json({ success: false, error: 'Extension disconnected before order could run', data: failed });
      return null;
    }

    const executing = this.orders.markExecuting(order.orderId);
    if (!executing) return null;

    socket.emit('extension:run_order', { orderId: executing.orderId, ...executing.input });
    this.broadcastOrder(executing);

    const created = this.orders.get(order.orderId);
    this.io.to('dashboards').emit('orders:created', { order: created });
    res?.status(201).json({ success: true, data: created });
    return created || order;
  }

  private startVerification(input: {
    orderId: string;
    extensionId: string;
    emailCodeSentAt: number;
  }): VerificationCodeRequest {
    const request = this.verificationStore.create(input);
    this.io.to('dashboards').emit('verification-requests:created', { request });

    void (async () => {
      try {
        const result = await this.gmail.waitForVerificationCode(input.emailCodeSentAt, { orderId: input.orderId });
        const completed = this.verificationStore.update(request.requestId, {
          status: 'completed',
          emailCode: result.emailCode,
          gmailAccountId: result.accountId,
          gmailMessageId: result.messageId,
          error: undefined
        });
        if (!completed) return;
        this.emitToExtension(input.extensionId, 'extension:verification_code_ready', {
          orderId: input.orderId,
          requestId: completed.requestId,
          emailCode: result.emailCode
        });
        this.io.to('dashboards').emit('verification-requests:updated', { request: completed });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Verification code lookup failed';
        const failed = this.verificationStore.update(request.requestId, { status: 'failed', error: message });
        if (!failed) return;
        this.emitToExtension(input.extensionId, 'extension:verification_code_failed', {
          orderId: input.orderId,
          requestId: failed.requestId,
          error: message
        });
        this.io.to('dashboards').emit('verification-requests:updated', { request: failed });
      }
    })();

    return request;
  }

  private emitToExtension(extensionId: string, event: string, payload: unknown): void {
    for (const [, socket] of this.io.sockets.sockets) {
      if (socket.data.extensionId === extensionId) socket.emit(event, payload);
    }
  }
}
