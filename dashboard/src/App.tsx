import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { GmailsPage } from './pages/GmailsPage';
import { ManualLaunchPage } from './pages/ManualLaunchPage';
import { OrdersPage } from './pages/OrdersPage';
import { LaunchAnalyzerPage } from './pages/LaunchAnalyzerPage';
import { TokenLaunchPage } from './pages/TokenLaunchPage';
import { WorkflowPage } from './pages/WorkflowPage';
import { io, Socket } from 'socket.io-client';
import { createOrder, cancelOrder, getActivity, getBackendUrl, getExtensions, getLaunchWorkflows, getOrders, getTokenLaunchJobs, type WithdrawOrderInput } from './api';
import type { ActivityItem, AutomationOrder, ExtensionRecord, LaunchWorkflow, TokenLaunchJob, VerificationCodeRequest } from './types';
import {
  ActivityMapper,
  ORDER_CANCELLED_MESSAGE,
  formatDuration,
  formatRelativeTime,
  formatUtcTime,
  isActiveOrderStatus,
  orderCompletedAt,
  orderStatusClass,
  shortId,
  upsertById,
  waitForExtensionIdle,
  waitForOrderCompleted
} from './utils';

const DEFAULT_WITHDRAW_INPUT: WithdrawOrderInput = {
  currency: 'ETH',
  chain: 'base',
  address: '0xF79a17Ab4857Bd6D64d3309AC6dF4Cf522B7bF45',
  amount: '0.001'
};

function Header({ connected }: { connected: boolean }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Token Automation
      </Link>
      <nav className="topbar-nav">
        <NavLink to="/workflow">Workflow</NavLink>
        <NavLink to="/" end>
          Extensions
        </NavLink>
        <NavLink to="/gmails">Gmails</NavLink>
        <NavLink to="/auto-launch">Auto Launch</NavLink>
        <NavLink to="/manual-launch">Manual Launch</NavLink>
        <NavLink to="/orders">Orders</NavLink>
      </nav>
      <span className={connected ? 'pill success' : 'pill muted'}>
        {connected ? 'Socket connected' : 'Socket disconnected'}
      </span>
    </header>
  );
}

function ExtensionsPage({
  extensions,
  reload,
  loading
}: {
  extensions: ExtensionRecord[];
  reload: () => void;
  loading: boolean;
}) {
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">No auth demo</p>
          <h1>Extensions</h1>
          <p className="subtle">Open the token automation extension side panel to register it here.</p>
        </div>
        <button type="button" onClick={reload} className="button secondary">
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="empty">Loading extensions...</div>
      ) : extensions.length === 0 ? (
        <div className="empty">No extensions connected yet.</div>
      ) : (
        <section className="grid">
          {extensions.map((extension) => (
            <Link
              key={extension.extensionId}
              to={`/extensions/${encodeURIComponent(extension.extensionId)}`}
              className="card"
            >
              <div className="card-title-row">
                <h2 title={extension.extensionId}>{shortId(extension.extensionId)}</h2>
                <span className="pill success">Online</span>
              </div>
              <p className="subtle">Last seen {formatRelativeTime(extension.lastSeen)}</p>
              <p className="url-line">{extension.currentUrl || 'No active tab reported'}</p>
            </Link>
          ))}
        </section>
      )}
    </main>
  );
}

function OrderList({
  orders,
  onCancel
}: {
  orders: AutomationOrder[];
  onCancel?: (orderId: string) => Promise<void>;
}) {
  const recentOrders = orders.slice(0, 3);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);

  const handleCancel = async (orderId: string) => {
    if (!onCancel) return;
    setCancelBusy(orderId);
    try {
      await onCancel(orderId);
    } finally {
      setCancelBusy(null);
    }
  };

  if (orders.length === 0) {
    return <div className="empty small">No orders sent to this extension yet.</div>;
  }

  return (
    <>
      <div className="order-list">
        {recentOrders.map((order) => (
          <article key={order.orderId} className="order-card">
            <div className="card-title-row">
              <strong>{order.input.text}</strong>
              <span className={orderStatusClass(order.status)}>{order.status}</span>
            </div>
            <p className="subtle order-summary">
              {order.input.amount} {order.input.currency} on {order.input.chain} to {order.input.address}
            </p>
            {order.executeTimeMs !== undefined && (
              <p className="subtle mono">Execute time {formatDuration(order.executeTimeMs)}</p>
            )}
            {order.output?.message && <p className="result">{order.output.message}</p>}
            {order.error && <p className="error">{order.error}</p>}
            {isActiveOrderStatus(order.status) && onCancel && (
              <div className="button-row" style={{ marginTop: 12 }}>
                <button
                  type="button"
                  className="button secondary danger-outline"
                  disabled={cancelBusy === order.orderId}
                  onClick={() => void handleCancel(order.orderId)}
                >
                  {cancelBusy === order.orderId ? 'Cancelling...' : 'Cancel'}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {orders.length > 3 && (
        <p className="subtle" style={{ marginTop: 12 }}>
          Showing latest 3 orders. <Link to="/orders">View all orders</Link>
        </p>
      )}
    </>
  );
}

function ExtensionDetailPage({
  extensions,
  orders,
  reloadOrders
}: {
  extensions: ExtensionRecord[];
  orders: AutomationOrder[];
  reloadOrders: (extensionId: string) => Promise<void>;
}) {
  const { extensionId: rawExtensionId } = useParams<{ extensionId: string }>();
  const extensionId = rawExtensionId ? decodeURIComponent(rawExtensionId) : '';
  const extension = extensions.find((item) => item.extensionId === extensionId);
  const extensionOrders = orders.filter((order) => order.extensionId === extensionId);
  const activeOrders = extensionOrders.filter((order) => isActiveOrderStatus(order.status));
  const hasActiveOrders = activeOrders.length > 0;
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [repeat, setRepeat] = useState(1);
  const [repeatProgress, setRepeatProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withdrawInput, setWithdrawInput] = useState<WithdrawOrderInput>(DEFAULT_WITHDRAW_INPUT);

  const updateWithdrawInput = (field: keyof WithdrawOrderInput, value: string) => {
    setWithdrawInput((current) => ({ ...current, [field]: value }));
  };

  useEffect(() => {
    if (!hasActiveOrders) return;
    const timer = window.setInterval(() => {
      void reloadOrders(extensionId);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [extensionId, hasActiveOrders, reloadOrders]);

  const sendOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const total = Math.max(1, Math.floor(Number(repeat) || 1));
    setSending(true);
    setError(null);
    setRepeatProgress(null);
    try {
      for (let index = 0; index < total; index += 1) {
        await waitForExtensionIdle(extensionId);
        setRepeatProgress({ current: index + 1, total });
        const order = await createOrder(extensionId, withdrawInput);
        await reloadOrders(extensionId);
        await waitForOrderCompleted(extensionId, order.orderId);
        await reloadOrders(extensionId);
      }
    } catch (err) {
      if (err instanceof Error && err.message === ORDER_CANCELLED_MESSAGE) {
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to send order');
    } finally {
      setSending(false);
      setRepeatProgress(null);
    }
  };

  const cancelActiveOrder = async () => {
    const target = activeOrders[0];
    if (!target) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelOrder(target.orderId);
      await reloadOrders(extensionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setCancelling(false);
    }
  };

  if (!extensionId) {
    return <Navigate to="/" replace />;
  }

  return (
    <main className="page narrow">
      <Link to="/" className="back-link">
        Back to extensions
      </Link>

      <div className="detail-panel">
        <p className="eyebrow">Extension</p>
        <h1 title={extensionId}>{shortId(extensionId)}</h1>
        <p className="subtle">
          {extension ? `Online, last seen ${formatRelativeTime(extension.lastSeen)}` : 'This extension is offline.'}
        </p>
        <p className="url-line">{extension?.currentUrl || 'No active tab reported'}</p>

        <form className="withdraw-form" onSubmit={sendOrder}>
          <label>
            Currency
            <input
              value={withdrawInput.currency}
              onChange={(event) => updateWithdrawInput('currency', event.target.value)}
              required
            />
          </label>
          <label>
            Chain
            <input value={withdrawInput.chain} onChange={(event) => updateWithdrawInput('chain', event.target.value)} required />
          </label>
          <label>
            Withdraw address
            <input
              value={withdrawInput.address}
              onChange={(event) => updateWithdrawInput('address', event.target.value)}
              required
            />
          </label>
          <label>
            Amount
            <input value={withdrawInput.amount} onChange={(event) => updateWithdrawInput('amount', event.target.value)} required />
          </label>
          <label>
            Email code (optional)
            <input value={withdrawInput.emailCode || ''} onChange={(event) => updateWithdrawInput('emailCode', event.target.value)} />
          </label>
          <label>
            Google Authenticator code (optional)
            <input
              value={withdrawInput.authenticatorCode || ''}
              onChange={(event) => updateWithdrawInput('authenticatorCode', event.target.value)}
            />
          </label>
          <label>
            Repeat
            <input
              type="number"
              min={1}
              step={1}
              value={repeat}
              onChange={(event) => setRepeat(Math.max(1, Math.floor(Number(event.target.value) || 1)))}
              disabled={sending}
            />
          </label>
          <button
            type="submit"
            className="button"
            disabled={
              !extension ||
              sending ||
              hasActiveOrders ||
              !withdrawInput.address.trim() ||
              !withdrawInput.amount.trim()
            }
          >
            {sending && repeatProgress
              ? `Sending ${repeatProgress.current}/${repeatProgress.total}...`
              : sending
                ? 'Sending...'
                : hasActiveOrders
                  ? 'Order in progress...'
                  : repeat > 1
                    ? `Send withdraw order (${repeat}x)`
                    : 'Send withdraw order'}
          </button>
        </form>
        {hasActiveOrders && !sending && (
          <div className="button-row" style={{ marginTop: 12 }}>
            <button
              type="button"
              className="button secondary danger-outline"
              disabled={cancelling}
              onClick={() => void cancelActiveOrder()}
            >
              {cancelling ? 'Cancelling...' : 'Cancel active withdraw'}
            </button>
          </div>
        )}
        {hasActiveOrders && !sending && (
          <p className="subtle">This extension is running an order. Wait for it to finish or cancel it above.</p>
        )}
        {sending && repeatProgress && repeatProgress.total > 1 && (
          <p className="subtle">
            Running order {repeatProgress.current} of {repeatProgress.total}. The next order starts when this one finishes.
          </p>
        )}
        <p className="subtle">
          The extension opens Bitunix withdraw, submits the form, waits for the email code from the backend Gmail service,
          and fills Google Authenticator automatically unless you provide codes here. Connect Gmail accounts on the Gmails tab.
        </p>
        {error && <p className="error">{error}</p>}
      </div>

      <section>
        <h2 className="section-title">Orders</h2>
        <OrderList
          orders={extensionOrders}
          onCancel={async (orderId) => {
            await cancelOrder(orderId);
            await reloadOrders(extensionId);
          }}
        />
      </section>
    </main>
  );
}

function App() {
  const [connected, setConnected] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);
  const [orders, setOrders] = useState<AutomationOrder[]>([]);
  const [tokenLaunches, setTokenLaunches] = useState<TokenLaunchJob[]>([]);
  const [workflows, setWorkflows] = useState<LaunchWorkflow[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [activityLoading, setActivityLoading] = useState(true);
  const socket = useMemo<Socket>(() => io(getBackendUrl(), { transports: ['websocket', 'polling'] }), []);

  const reloadExtensions = useCallback(async () => {
    setLoading(true);
    try {
      setExtensions(await getExtensions());
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadOrders = useCallback(async (extensionId?: string) => {
    const next = await getOrders(extensionId);
    setOrders((current) => {
      const others = extensionId ? current.filter((order) => order.extensionId !== extensionId) : [];
      return [...next, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }, []);

  const reloadTokenLaunches = useCallback(async () => {
    setTokenLaunches(await getTokenLaunchJobs());
  }, []);

  const reloadWorkflows = useCallback(async () => {
    setWorkflows(await getLaunchWorkflows());
  }, []);

  const reloadActivity = useCallback(async () => {
    setActivityLoading(true);
    try {
      setActivity(await getActivity());
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    socket.on('connect', () => {
      setConnected(true);
      socket.emit('dashboard:connect');
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('dashboard:connected', (data: {
      extensions: ExtensionRecord[];
      orders: AutomationOrder[];
      tokenLaunches?: TokenLaunchJob[];
      workflows?: LaunchWorkflow[];
      activity?: ActivityItem[];
    }) => {
      setExtensions(data.extensions || []);
      setOrders(data.orders || []);
      setTokenLaunches(data.tokenLaunches || []);
      setWorkflows(data.workflows || []);
      setActivity(data.activity || []);
      setLoading(false);
      setActivityLoading(false);
    });
    socket.on('extensions:updated', (data: { extensions: ExtensionRecord[] }) => {
      setExtensions(data.extensions || []);
      setLoading(false);
    });
    socket.on('orders:created', (data: { order: AutomationOrder }) => {
      setOrders((current) => upsertById(current, data.order, (o) => o.orderId, data.order.orderId));
      setActivity((current) =>
        upsertById(current, ActivityMapper.fromOrder(data.order), (i) => `${i.kind}:${i.id}`, `withdraw:${data.order.orderId}`)
      );
    });
    socket.on('orders:updated', (data: { order: AutomationOrder }) => {
      setOrders((current) => upsertById(current, data.order, (o) => o.orderId, data.order.orderId));
      setActivity((current) =>
        upsertById(current, ActivityMapper.fromOrder(data.order), (i) => `${i.kind}:${i.id}`, `withdraw:${data.order.orderId}`)
      );
    });
    socket.on('verification-requests:created', (data: { request: VerificationCodeRequest }) => {
      setActivity((current) =>
        upsertById(
          current,
          ActivityMapper.fromVerification(data.request),
          (i) => `${i.kind}:${i.id}`,
          `email_verification:${data.request.requestId}`
        )
      );
    });
    socket.on('verification-requests:updated', (data: { request: VerificationCodeRequest }) => {
      setActivity((current) =>
        upsertById(
          current,
          ActivityMapper.fromVerification(data.request),
          (i) => `${i.kind}:${i.id}`,
          `email_verification:${data.request.requestId}`
        )
      );
    });

    socket.on('tokenlaunch:created', (data: { job: TokenLaunchJob }) => {
      setTokenLaunches((current) => upsertById(current, data.job, (j) => j.jobId, data.job.jobId));
      setActivity((current) =>
        upsertById(current, ActivityMapper.fromTokenLaunch(data.job), (i) => `${i.kind}:${i.id}`, `token_launch:${data.job.jobId}`)
      );
    });
    socket.on('tokenlaunch:updated', (data: { job: TokenLaunchJob }) => {
      setTokenLaunches((current) => upsertById(current, data.job, (j) => j.jobId, data.job.jobId));
      setActivity((current) =>
        upsertById(current, ActivityMapper.fromTokenLaunch(data.job), (i) => `${i.kind}:${i.id}`, `token_launch:${data.job.jobId}`)
      );
    });

    socket.on('workflow:created', (data: { workflow: LaunchWorkflow }) => {
      setWorkflows((current) => upsertById(current, data.workflow, (w) => w.workflowId, data.workflow.workflowId));
      setActivity((current) =>
        upsertById(
          current,
          ActivityMapper.fromLaunchWorkflow(data.workflow),
          (i) => `${i.kind}:${i.id}`,
          `launch_workflow:${data.workflow.workflowId}`
        )
      );
    });
    socket.on('workflow:updated', (data: { workflow: LaunchWorkflow }) => {
      setWorkflows((current) => upsertById(current, data.workflow, (w) => w.workflowId, data.workflow.workflowId));
      setActivity((current) =>
        upsertById(
          current,
          ActivityMapper.fromLaunchWorkflow(data.workflow),
          (i) => `${i.kind}:${i.id}`,
          `launch_workflow:${data.workflow.workflowId}`
        )
      );
    });

    void reloadExtensions();
    void reloadOrders();
    void reloadTokenLaunches();
    void reloadWorkflows();
    void reloadActivity();

    return () => {
      socket.disconnect();
    };
  }, [socket, reloadExtensions, reloadOrders, reloadTokenLaunches, reloadWorkflows, reloadActivity]);

  return (
    <>
      <Header connected={connected} />
      <Routes>
        <Route
          path="/"
          element={<ExtensionsPage extensions={extensions} reload={reloadExtensions} loading={loading} />}
        />
        <Route
          path="/extensions/:extensionId"
          element={<ExtensionDetailPage extensions={extensions} orders={orders} reloadOrders={reloadOrders} />}
        />
        <Route path="/gmails" element={<GmailsPage />} />
        <Route
          path="/auto-launch"
          element={<TokenLaunchPage jobs={tokenLaunches} reloadJobs={reloadTokenLaunches} />}
        />
        <Route path="/manual-launch" element={<ManualLaunchPage />} />
        <Route
          path="/workflow"
          element={
            <WorkflowPage extensions={extensions} workflows={workflows} reloadWorkflows={reloadWorkflows} />
          }
        />
        {/* Old bookmarks — the pages moved under the auto/manual split. */}
        <Route path="/tokenlaunch" element={<Navigate to="/auto-launch" replace />} />
        <Route path="/liquidity" element={<Navigate to="/manual-launch" replace />} />
        <Route path="/tokenlaunch/:jobId" element={<LaunchAnalyzerPage />} />
        <Route
          path="/orders"
          element={<OrdersPage activity={activity} reload={() => void reloadActivity()} loading={activityLoading} />}
        />
      </Routes>
    </>
  );
}

export default App;
