import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { GmailsPage } from './pages/GmailsPage';
import { OrdersPage } from './pages/OrdersPage';
import { io, Socket } from 'socket.io-client';
import { createOrder, getActivity, getBackendUrl, getExtensions, getOrders, type WithdrawOrderInput } from './api';
import type { ActivityItem, AutomationOrder, ExtensionRecord, VerificationCodeRequest } from './types';

function formatRelativeTime(value: string): string {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return 'unknown';
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function shortId(extensionId: string): string {
  return extensionId.length > 20 ? `${extensionId.slice(0, 18)}...` : extensionId;
}

const DEFAULT_WITHDRAW_INPUT: WithdrawOrderInput = {
  currency: 'ETH',
  chain: 'base',
  address: '0xF79a17Ab4857Bd6D64d3309AC6dF4Cf522B7bF45',
  amount: '0.001'
};

function upsertOrder(orders: AutomationOrder[], order: AutomationOrder): AutomationOrder[] {
  const existing = orders.findIndex((item) => item.orderId === order.orderId);
  if (existing === -1) {
    return [order, ...orders];
  }
  const next = [...orders];
  next[existing] = order;
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function upsertActivityItem(items: ActivityItem[], item: ActivityItem): ActivityItem[] {
  const index = items.findIndex((entry) => entry.id === item.id && entry.kind === item.kind);
  if (index === -1) {
    return [item, ...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const next = [...items];
  next[index] = item;
  return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function verificationToActivity(request: VerificationCodeRequest): ActivityItem {
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

function withdrawToActivity(order: AutomationOrder): ActivityItem {
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

function Header({ connected }: { connected: boolean }) {
  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Token Automation
      </Link>
      <nav className="topbar-nav">
        <NavLink to="/" end>
          Extensions
        </NavLink>
        <NavLink to="/gmails">Gmails</NavLink>
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

function OrderList({ orders }: { orders: AutomationOrder[] }) {
  if (orders.length === 0) {
    return <div className="empty small">No orders sent to this extension yet.</div>;
  }

  return (
    <div className="order-list">
      {orders.map((order) => (
        <article key={order.orderId} className="order-card">
          <div className="card-title-row">
            <strong>{order.input.text}</strong>
            <span className={`pill ${order.status === 'completed' ? 'success' : order.status === 'failed' ? 'danger' : ''}`}>
              {order.status}
            </span>
          </div>
          <p className="subtle order-summary">
            {order.input.amount} {order.input.currency} on {order.input.chain} to {order.input.address}
          </p>
          <p className="mono">{order.orderId}</p>
          {order.output?.pageUrl && <p className="url-line">{order.output.pageUrl}</p>}
          {order.output?.message && <p className="result">{order.output.message}</p>}
          {order.error && <p className="error">{order.error}</p>}
        </article>
      ))}
    </div>
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [withdrawInput, setWithdrawInput] = useState<WithdrawOrderInput>(DEFAULT_WITHDRAW_INPUT);

  const updateWithdrawInput = (field: keyof WithdrawOrderInput, value: string) => {
    setWithdrawInput((current) => ({ ...current, [field]: value }));
  };

  const sendOrder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      await createOrder(extensionId, withdrawInput);
      await reloadOrders(extensionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send order');
    } finally {
      setSending(false);
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
          <button
            type="submit"
            className="button"
            disabled={!extension || sending || !withdrawInput.address.trim() || !withdrawInput.amount.trim()}
          >
            {sending ? 'Sending...' : 'Send withdraw order'}
          </button>
        </form>
        <p className="subtle">
          The extension opens Bitunix withdraw, submits the form, waits for the email code from the backend Gmail service,
          and fills Google Authenticator automatically unless you provide codes here. Connect Gmail accounts on the Gmails tab.
        </p>
        {error && <p className="error">{error}</p>}
      </div>

      <section>
        <h2 className="section-title">Orders</h2>
        <OrderList orders={extensionOrders} />
      </section>
    </main>
  );
}

function App() {
  const [connected, setConnected] = useState(false);
  const [extensions, setExtensions] = useState<ExtensionRecord[]>([]);
  const [orders, setOrders] = useState<AutomationOrder[]>([]);
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
    socket.on('dashboard:connected', (data: { extensions: ExtensionRecord[]; orders: AutomationOrder[]; activity?: ActivityItem[] }) => {
      setExtensions(data.extensions || []);
      setOrders(data.orders || []);
      setActivity(data.activity || []);
      setLoading(false);
      setActivityLoading(false);
    });
    socket.on('extensions:updated', (data: { extensions: ExtensionRecord[] }) => {
      setExtensions(data.extensions || []);
      setLoading(false);
    });
    socket.on('orders:created', (data: { order: AutomationOrder }) => {
      setOrders((current) => upsertOrder(current, data.order));
      setActivity((current) => upsertActivityItem(current, withdrawToActivity(data.order)));
    });
    socket.on('orders:updated', (data: { order: AutomationOrder }) => {
      setOrders((current) => upsertOrder(current, data.order));
      setActivity((current) => upsertActivityItem(current, withdrawToActivity(data.order)));
    });
    socket.on('verification-requests:created', (data: { request: VerificationCodeRequest }) => {
      setActivity((current) => upsertActivityItem(current, verificationToActivity(data.request)));
    });
    socket.on('verification-requests:updated', (data: { request: VerificationCodeRequest }) => {
      setActivity((current) => upsertActivityItem(current, verificationToActivity(data.request)));
    });

    void reloadExtensions();
    void reloadOrders();
    void reloadActivity();

    return () => {
      socket.disconnect();
    };
  }, [socket, reloadExtensions, reloadOrders, reloadActivity]);

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
          path="/orders"
          element={<OrdersPage activity={activity} reload={() => void reloadActivity()} loading={activityLoading} />}
        />
      </Routes>
    </>
  );
}

export default App;
