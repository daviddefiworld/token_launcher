import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityItem } from '../types';
import { formatDuration, formatUtcTime, shortId } from '../utils';

function kindLabel(kind: ActivityItem['kind']): string {
  return kind === 'email_verification' ? 'Email check' : 'Withdraw';
}

function statusClass(status: string): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed') return 'pill danger';
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
  const filtered = filter === 'all' ? activity : activity.filter((item) => item.kind === filter);

  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Activity log</p>
          <h1>Orders</h1>
          <p className="subtle">Withdraw orders and Gmail verification code lookups from the extension.</p>
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
      </div>

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
