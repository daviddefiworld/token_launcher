import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cancelOrder } from '../api';
import type { ActivityItem, AutomationOrder } from '../types';
import { formatDuration, formatUtcTime, isActiveOrderStatus, shortId } from '../utils';

function kindLabel(kind: ActivityItem['kind']): string {
  if (kind === 'email_verification') return 'Email check';
  if (kind === 'token_launch') return 'Token launch';
  return 'Withdraw';
}

function statusClass(status: string): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed') return 'pill danger';
  if (status === 'cancelled') return 'pill warning';
  if (status === 'executing' || status === 'pending') return 'pill muted';
  return 'pill';
}

export function OrdersPage({
  activity,
  reload,
  loading
}: {
  activity: ActivityItem[];
  reload: () => void;
  loading: boolean;
}) {
  const [filter, setFilter] = useState<'all' | ActivityItem['kind']>('all');
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const filtered = filter === 'all' ? activity : activity.filter((item) => item.kind === filter);

  const handleCancel = async (orderId: string) => {
    setCancelBusy(orderId);
    setCancelError(null);
    try {
      await cancelOrder(orderId);
      reload();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : 'Failed to cancel order');
    } finally {
      setCancelBusy(null);
    }
  };

  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Activity log</p>
          <h1>Orders</h1>
          <p className="subtle">Withdraw orders, token launches, and Gmail verification lookups.</p>
        </div>
        <button type="button" className="button secondary" onClick={reload} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="button-row" style={{ marginBottom: 16 }}>
        <button type="button" className={`button secondary${filter === 'all' ? ' active-filter' : ''}`} onClick={() => setFilter('all')}>
          All
        </button>
        <button
          type="button"
          className={`button secondary${filter === 'withdraw' ? ' active-filter' : ''}`}
          onClick={() => setFilter('withdraw')}
        >
          Withdraw
        </button>
        <button
          type="button"
          className={`button secondary${filter === 'email_verification' ? ' active-filter' : ''}`}
          onClick={() => setFilter('email_verification')}
        >
          Email check
        </button>
        <button
          type="button"
          className={`button secondary${filter === 'token_launch' ? ' active-filter' : ''}`}
          onClick={() => setFilter('token_launch')}
        >
          Token launch
        </button>
      </div>

      {cancelError && <p className="error">{cancelError}</p>}

      {loading ? (
        <div className="empty">Loading orders...</div>
      ) : filtered.length === 0 ? (
        <div className="empty">No orders yet.</div>
      ) : (
        <div className="order-list">
          {filtered.map((item) => (
            <article key={`${item.kind}-${item.id}`} className="order-card">
              <div className="card-title-row">
                <div>
                  <span className="pill muted">{kindLabel(item.kind)}</span>
                  <strong style={{ display: 'block', marginTop: 8 }}>{item.title}</strong>
                </div>
                <span className={statusClass(item.status)}>{item.status}</span>
              </div>
              {item.summary && <p className="subtle order-summary">{item.summary}</p>}
              <p className="mono">{shortId(item.id)}</p>
              <p className="subtle">Extension {shortId(item.extensionId)}</p>
              {item.kind === 'withdraw' && item.executeTimeMs !== undefined && (
                <p className="subtle mono">Execute time {formatDuration(item.executeTimeMs)}</p>
              )}
              {item.kind === 'email_verification' && item.emailCodeSentAt !== undefined && (
                <p className="subtle mono">Get code at {formatUtcTime(new Date(item.emailCodeSentAt).toISOString())}</p>
              )}
              {item.parentOrderId && (
                <p className="subtle">
                  Linked withdraw: <span className="mono">{shortId(item.parentOrderId)}</span>
                </p>
              )}
              {item.emailCode && <p className="result">Email code: {item.emailCode}</p>}
              {item.message && item.kind === 'withdraw' && <p className="result">{item.message}</p>}
              {item.pageUrl && <p className="url-line">{item.pageUrl}</p>}
              {item.error && <p className="error">{item.error}</p>}
              {item.kind === 'withdraw' && isActiveOrderStatus(item.status as AutomationOrder['status']) && (
                <div className="button-row" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="button secondary danger-outline"
                    disabled={cancelBusy === item.id}
                    onClick={() => void handleCancel(item.id)}
                  >
                    {cancelBusy === item.id ? 'Cancelling...' : 'Cancel withdraw'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <p className="subtle" style={{ marginTop: 24 }}>
        <Link to="/">Back to extensions</Link>
      </p>
    </main>
  );
}
