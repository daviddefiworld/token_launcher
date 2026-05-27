import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  disconnectGmailAccount,
  getGmailAccounts,
  getGmailConnectUrl,
  getGmailMessages,
  getGmailStatus,
  setDefaultGmailAccount,
  syncGmailAccount,
  syncGmailAccounts
} from '../api';
import type { CachedGmailMessage, GmailAccount } from '../types';
import { formatRelativeTime, formatUtcTime } from '../utils';

export function GmailsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [configured, setConfigured] = useState(false);
  const [accounts, setAccounts] = useState<GmailAccount[]>([]);
  const [messages, setMessages] = useState<CachedGmailMessage[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await getGmailStatus();
      setConfigured(status.configured);
      setAccounts(status.accounts);
      const accountId = selectedAccountId || status.accounts.find((account) => account.isDefault)?.id || status.accounts[0]?.id || '';
      setSelectedAccountId(accountId);
      setMessages(await getGmailMessages(accountId || undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Gmail accounts');
    } finally {
      setLoading(false);
    }
  }, [selectedAccountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const connected = searchParams.get('connected');
    const oauthError = searchParams.get('error');
    if (connected) {
      setNotice('Gmail account connected.');
      setSearchParams({}, { replace: true });
    } else if (oauthError) {
      setError(oauthError);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const connectGmail = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await getGmailConnectUrl();
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start Gmail OAuth');
      setBusy(false);
    }
  };

  const syncAll = async () => {
    setBusy(true);
    setError(null);
    try {
      setAccounts(await syncGmailAccounts());
      setMessages(await getGmailMessages(selectedAccountId || undefined));
      setNotice('Synced Bitunix emails from all connected accounts.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const syncOne = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      const account = await syncGmailAccount(accountId);
      setAccounts(await getGmailAccounts());
      if (selectedAccountId === accountId || !selectedAccountId) {
        setMessages(await getGmailMessages(accountId));
      }
      setNotice(`Synced ${account.email}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setDefaultGmailAccount(accountId);
      setAccounts(await getGmailAccounts());
      setSelectedAccountId(accountId);
      setNotice('Default Gmail account updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update default account');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (accountId: string) => {
    setBusy(true);
    setError(null);
    try {
      await disconnectGmailAccount(accountId);
      await reload();
      setNotice('Gmail account disconnected.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect account');
    } finally {
      setBusy(false);
    }
  };

  const onAccountFilterChange = async (accountId: string) => {
    setSelectedAccountId(accountId);
    setMessages(await getGmailMessages(accountId || undefined));
  };

  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Gmail API</p>
          <h1>Gmails</h1>
          <p className="subtle">
            Connect Gmail accounts here. The backend reads Bitunix verification emails and supplies codes to the extension
            during withdraw verification.
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="button secondary" onClick={() => void reload()} disabled={loading || busy}>
            Refresh
          </button>
          <button type="button" className="button secondary" onClick={() => void syncAll()} disabled={!configured || busy || accounts.length === 0}>
            Sync all
          </button>
          <button type="button" className="button" onClick={() => void connectGmail()} disabled={!configured || busy}>
            Connect Gmail
          </button>
        </div>
      </div>

      {!configured && (
        <div className="empty">
          Gmail API is not configured on the backend. Set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>{' '}
          in <code>backend/.env</code>, then restart the backend.
        </div>
      )}

      {notice && <p className="result">{notice}</p>}
      {error && <p className="error">{error}</p>}

      {loading ? (
        <div className="empty">Loading Gmail accounts...</div>
      ) : accounts.length === 0 ? (
        <div className="empty">No Gmail accounts connected yet.</div>
      ) : (
        <section className="grid">
          {accounts.map((account) => (
            <article key={account.id} className="card static-card">
              <div className="card-title-row">
                <h2>{account.email}</h2>
                {account.isDefault ? <span className="pill success">Default</span> : <span className="pill muted">Connected</span>}
              </div>
              <p className="subtle">Connected {formatRelativeTime(account.connectedAt)}</p>
              <p className="subtle">Last sync {formatRelativeTime(account.lastSyncAt)}</p>
              {account.lastError && <p className="error">{account.lastError}</p>}
              <div className="button-row">
                {!account.isDefault && (
                  <button type="button" className="button secondary" disabled={busy} onClick={() => void makeDefault(account.id)}>
                    Make default
                  </button>
                )}
                <button type="button" className="button secondary" disabled={busy} onClick={() => void syncOne(account.id)}>
                  Sync
                </button>
                <button type="button" className="button secondary danger-outline" disabled={busy} onClick={() => void disconnect(account.id)}>
                  Disconnect
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="detail-panel" style={{ marginTop: 32 }}>
        <div className="page-heading" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="section-title">Last 5 Bitunix emails</h2>
            <p className="subtle">Most recent messages from the last sync. Verification codes appear when detected.</p>
          </div>
          <label>
            Account filter
            <select
              value={selectedAccountId}
              onChange={(event) => void onAccountFilterChange(event.target.value)}
              disabled={accounts.length === 0}
            >
              <option value="">All accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.email}
                </option>
              ))}
            </select>
          </label>
        </div>

        {messages.length === 0 ? (
          <div className="empty small">No Bitunix emails cached yet. Connect an account and run Sync.</div>
        ) : (
          <div className="order-list">
            {messages.map((message) => (
              <article key={`${message.accountId}-${message.id}`} className="order-card">
                <div className="card-title-row">
                  <strong>{message.subject || '(no subject)'}</strong>
                  {message.verificationCode ? <span className="pill success">Code {message.verificationCode}</span> : null}
                </div>
                <p className="subtle">{message.from}</p>
                <p className="subtle mono">Received {formatUtcTime(message.receivedAt)}</p>
                <p className="order-summary">{message.snippet}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="subtle" style={{ marginTop: 24 }}>
        <Link to="/">Back to extensions</Link>
      </p>
    </main>
  );
}
