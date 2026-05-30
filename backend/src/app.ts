import cors from 'cors';
import { createHmac } from 'crypto';
import { randomUUID } from 'crypto';
import express, { Request, Response, Router } from 'express';
import { createServer, Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { GmailService } from './gmail';
import { networkTime } from './networkTime';
import { GmailRepository, OrderRepository, TokenLaunchRepository, VerificationRepository, WorkflowRepository, nowIso } from './persist';
import { TokenLaunchInputParser, TokenLaunchService } from './skills/tokenlaunch';
import { LaunchWorkflowInputParser, LaunchWorkflowService } from './workflow';
import type {
  ActivityItem,
  AutomationOrder,
  ExtensionRecord,
  LaunchWorkflow,
  TokenLaunchJob,
  VerificationCodeRequest,
  WithdrawRequest
} from './types';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PORT = Number(process.env.PORT || 5050);

class TotpAuthenticator {
  async generate(): Promise<string> {
    const secret = process.env.GOOGLE_AUTHENTICATOR_SECRET?.trim();
    if (!secret) throw new Error('GOOGLE_AUTHENTICATOR_SECRET is not configured in backend/.env');
    await networkTime.sync();
    return TotpAuthenticator.code(secret, networkTime.now());
  }

  private static code(secret: string, timestampMs: number, stepSeconds = 30): string {
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
  constructor(
    private readonly verification: VerificationRepository,
    private readonly tokenLaunches: TokenLaunchRepository,
    private readonly workflows: WorkflowRepository
  ) {}

  build(orders: AutomationOrder[], extensionId?: string): ActivityItem[] {
    const verification = this.verification.list(extensionId);
    const launches = this.tokenLaunches.list();
    const workflowItems = this.workflows.list();
    const items: ActivityItem[] = [
      ...orders
        .filter((o) => !extensionId || o.extensionId === extensionId)
        .map((o) => ActivityFeed.fromOrder(o)),
      ...verification.map((r) => ActivityFeed.fromVerification(r)),
      ...launches.map((job) => ActivityFeed.fromTokenLaunch(job)),
      ...workflowItems.map((workflow) => ActivityFeed.fromLaunchWorkflow(workflow))
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

  private static fromTokenLaunch(job: TokenLaunchJob): ActivityItem {
    return {
      id: job.jobId,
      kind: 'token_launch',
      extensionId: 'tokenlaunch',
      status: job.status,
      title: `Token launch: ${job.input.tokenName}`,
      summary: `${job.input.lpEthAmount} ETH LP on Base · ${job.phase || job.status}`,
      tokenLaunch: {
        tokenName: job.input.tokenName,
        tokenSymbol: job.input.tokenSymbol,
        lpEthAmount: job.input.lpEthAmount,
        buyEthAmount: job.input.buyEthAmount,
        tokenAddress: job.tokenAddress,
        poolAddress: job.poolAddress,
        buyerCount: job.buyerCount,
        phase: job.phase
      },
      error: job.error,
      message: job.phase,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  private static fromLaunchWorkflow(workflow: LaunchWorkflow): ActivityItem {
    return {
      id: workflow.workflowId,
      kind: 'launch_workflow',
      extensionId: workflow.input.extensionId,
      status: workflow.status,
      title: `Launch workflow: ${workflow.input.tokenLaunch.tokenName}`,
      summary: `${workflow.input.walletCount} wallets · ${workflow.phase || workflow.status}`,
      launchWorkflow: {
        walletCount: workflow.input.walletCount,
        autoStartLaunch: workflow.input.autoStartLaunch,
        launchJobId: workflow.launchJobId,
        phase: workflow.phase,
        hasWallets: Boolean(workflow.wallets?.length)
      },
      error: workflow.error,
      message: workflow.phase,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt
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
  private readonly tokenLaunches = new TokenLaunchRepository();
  private readonly workflows = new WorkflowRepository();
  private readonly gmailStore = new GmailRepository();
  private readonly verificationStore = new VerificationRepository();
  private readonly gmail = new GmailService(this.gmailStore);
  private readonly activity = new ActivityFeed(this.verificationStore, this.tokenLaunches, this.workflows);
  private readonly tokenLaunch = new TokenLaunchService(this.tokenLaunches, (job, event) =>
    this.io.to('dashboards').emit(`tokenlaunch:${event}`, { job })
  );
  private readonly launchWorkflow = new LaunchWorkflowService(
    this.workflows,
    this.tokenLaunch,
    async (extensionId, input) => this.submitWithdrawOrder(extensionId, input),
    (orderId) => this.orders.get(orderId),
    (workflow, event) => this.io.to('dashboards').emit(`workflow:${event}`, { workflow })
  );
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
    app.use('/api/tokenlaunch', this.tokenLaunchRoutes());
    app.use('/api/workflows', this.workflowRoutes());
    this.coreRoutes(app);

    this.io.on('connection', (socket) => this.onSocket(socket));

    this.httpServer.listen(PORT, () => {
      networkTime.startBackgroundSync();
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

    app.post('/api/orders/:orderId/cancel', (req, res) => {
      try {
        const order = this.cancelOrder(req.params.orderId);
        res.json({ success: true, data: order });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to cancel order';
        const status = message.includes('not found')
          ? 404
          : message.includes('Only active')
            ? 409
            : 400;
        res.status(status).json({ success: false, error: message });
      }
    });
  }

  private tokenLaunchRoutes(): Router {
    const router = Router();

    router.get('/status', (_req, res) => {
      try {
        res.json({ success: true, data: this.tokenLaunch.getStatus() });
      } catch (error) {
        res.status(503).json({ success: false, error: error instanceof Error ? error.message : 'Token launch unavailable' });
      }
    });

    router.get('/', (_req, res) => {
      res.json({ success: true, data: this.tokenLaunch.list() });
    });

    router.get('/lp/unremoved', async (_req, res) => {
      try {
        const positions = await this.tokenLaunch.listUnremovedLp();
        res.json({ success: true, data: positions });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to list unremoved LP';
        res.status(message.includes('must be set') ? 503 : 500).json({ success: false, error: message });
      }
    });

    router.get('/:jobId/trades', async (req, res) => {
      try {
        const refresh = req.query.refresh === 'true' || req.query.refresh === '1';
        const data = await this.tokenLaunch.getTrades(req.params.jobId, refresh);
        res.json({ success: true, data });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load trades';
        const status = message.includes('not found')
          ? 404
          : message.includes('not available')
            ? 409
            : message.includes('must be set')
              ? 503
              : 500;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/trades/backfill', async (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const onlyMissing = body.onlyMissing !== false;
        const data = await this.tokenLaunch.backfillAllTrades({ onlyMissing });
        res.json({ success: true, data });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Trades backfill failed';
        const status = message.includes('already running') ? 409 : message.includes('must be set') ? 503 : 500;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/lp/remove', async (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const poolAddress = typeof body.poolAddress === 'string' ? body.poolAddress.trim() : '';
        const all = body.all === true;
        const results = await this.tokenLaunch.removeUnremovedLp(
          all ? { all: true } : { poolAddress }
        );
        res.json({ success: true, data: results });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove LP';
        const status = message.includes('running') ? 409 : message.includes('must be set') ? 503 : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/:jobId/finish', (req, res) => {
      try {
        const job = this.tokenLaunch.finish(req.params.jobId);
        res.json({ success: true, data: job });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to finish launch';
        const status = message.includes('not found')
          ? 404
          : message.includes('Only active')
            ? 409
            : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/:jobId/buy', async (req, res) => {
      try {
        const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
        const walletRaw = body.wallet;
        const wallet =
          walletRaw === 2 || walletRaw === '2' ? 2 : walletRaw === 3 || walletRaw === '3' ? 3 : null;
        if (wallet === null) {
          res.status(400).json({ success: false, error: 'wallet must be 2 or 3' });
          return;
        }
        const ethAmount = typeof body.ethAmount === 'string' ? body.ethAmount.trim() : undefined;
        const job = await this.tokenLaunch.manualBuy(req.params.jobId, wallet, ethAmount);
        res.json({ success: true, data: job });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Manual buy failed';
        const status = message.includes('not found')
          ? 404
          : message.includes('not available') || message.includes('not ready') || message.includes('in progress')
            ? 409
            : message.includes('must be set')
              ? 503
              : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.get('/:jobId', (req, res) => {
      const job = this.tokenLaunch.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ success: false, error: 'Token launch job not found' });
        return;
      }
      res.json({ success: true, data: job });
    });

    router.post('/', (req, res) => {
      try {
        const job = this.tokenLaunch.start(TokenLaunchInputParser.parse(req.body));
        res.status(201).json({ success: true, data: job });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid token launch request';
        const status = message.includes('already running') ? 409 : message.includes('must be set') ? 503 : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    return router;
  }

  private workflowRoutes(): Router {
    const router = Router();

    router.get('/', (_req, res) => {
      res.json({ success: true, data: this.launchWorkflow.list() });
    });

    router.get('/:workflowId', (req, res) => {
      const workflow = this.launchWorkflow.get(req.params.workflowId);
      if (!workflow) {
        res.status(404).json({ success: false, error: 'Launch workflow not found' });
        return;
      }
      res.json({ success: true, data: workflow });
    });

    router.post('/', (req, res) => {
      try {
        const workflow = this.launchWorkflow.start(LaunchWorkflowInputParser.parse(req.body));
        res.status(201).json({ success: true, data: workflow });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid launch workflow request';
        const status = message.includes('already running') ? 409 : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/:workflowId/cancel', (req, res) => {
      try {
        const workflow = this.launchWorkflow.cancel(req.params.workflowId);
        res.json({ success: true, data: workflow });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to cancel workflow';
        const status = message.includes('not found')
          ? 404
          : message.includes('Only active')
            ? 409
            : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    router.post('/:workflowId/deposit', async (req, res) => {
      try {
        const workflow = await this.launchWorkflow.deposit(req.params.workflowId);
        res.json({ success: true, data: workflow });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to deposit workflow funds';
        const status = message.includes('not found')
          ? 404
          : message.includes('still running') || message.includes('already in progress')
            ? 409
            : 400;
        res.status(status).json({ success: false, error: message });
      }
    });

    return router;
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
        tokenLaunches: this.tokenLaunch.list(),
        workflows: this.launchWorkflow.list(),
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
      async (ack?: (r: { success: boolean; authenticatorCode?: string; error?: string }) => void) => {
        if (!socket.data.extensionId) {
          ack?.({ success: false, error: 'Extension is not registered' });
          return;
        }
        try {
          ack?.({ success: true, authenticatorCode: await this.totp.generate() });
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
        const existing = this.orders.get(data.orderId);
        if (existing?.status === 'cancelled') return;
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

  private cancelOrder(orderId: string): AutomationOrder {
    this.flushExpiredOrders();
    const id = orderId.trim();
    const order = this.orders.get(id);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'pending' && order.status !== 'executing') {
      throw new Error('Only active orders can be cancelled');
    }
    const cancelled = this.orders.cancel(id);
    if (!cancelled) throw new Error('Order not found');
    this.emitToExtension(cancelled.extensionId, 'extension:cancel_order', { orderId: cancelled.orderId });
    this.broadcastOrder(cancelled);
    return cancelled;
  }

  private createOrder(extensionId: string, input: WithdrawRequest, res?: Response): AutomationOrder | null {
    try {
      return this.submitWithdrawOrder(extensionId, input, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create order';
      res?.status(409).json({ success: false, error: message });
      if (!res) throw error instanceof Error ? error : new Error(message);
      return null;
    }
  }

  private submitWithdrawOrder(extensionId: string, input: WithdrawRequest, res?: Response): AutomationOrder {
    this.flushExpiredOrders();
    const id = extensionId.trim();
    if (!this.extensions.has(id)) {
      if (res) {
        res.status(404).json({ success: false, error: `Extension ${id} is not connected` });
        return null as unknown as AutomationOrder;
      }
      throw new Error(`Extension ${id} is not connected`);
    }

    const active = this.orders.findActiveForExtension(id);
    if (active) {
      const message = 'Extension already has a running order';
      if (res) {
        res.status(409).json({ success: false, error: message });
        return null as unknown as AutomationOrder;
      }
      throw new Error(message);
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
      if (res) {
        res.status(409).json({ success: false, error: 'Extension disconnected before order could run', data: failed });
        return null as unknown as AutomationOrder;
      }
      throw new Error('Extension disconnected before order could run');
    }

    const executing = this.orders.markExecuting(order.orderId);
    if (!executing) {
      throw new Error('Failed to mark order as executing');
    }

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
