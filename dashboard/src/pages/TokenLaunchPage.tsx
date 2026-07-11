import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  getTokenLaunchStatus,
  getUnremovedLp,
  finishTokenLaunch,
  manualTokenLaunchBuy,
  removeUnremovedLp,
  startTokenLaunch,
  type TokenLaunchInput
} from '../api';
import type { DexKey, LpRemovalResult, TokenLaunchJob, TokenLaunchStatus, UnremovedLpPosition } from '../types';
import { formatRelativeTime, shortId } from '../utils';

const DEX_LABELS: Record<DexKey, string> = {
  aerodrome: 'Aerodrome',
  uniswap: 'Uniswap V2'
};

const DEX_ORDER: DexKey[] = ['uniswap', 'aerodrome'];

function dexLabel(dex?: DexKey): string {
  return dex ? DEX_LABELS[dex] : DEX_LABELS.aerodrome;
}

const DEFAULT_INPUT: TokenLaunchInput = {
  dex: 'uniswap',
  tokenName: 'AI',
  tokenSymbol: 'AI',
  lpEthAmount: '0.01',
  wallet2BuyEthAmount: '0.001',
  buyEthAmount: '0.001',
  useWallet3: false,
  buyAfterSeconds: 30,
  repeatCount: 1,
  removeLp: true,
  removeLpTimeMinutes: 5,
  minBuyersBeforeRemoveLp: 1
};

// Rough gas headroom per wallet (mirrors the workflow's withdraw buffers).
const W1_GAS_BUFFER = 0.004;
const BUY_GAS_BUFFER = 0.001;

const HISTORY_PAGE_SIZE = 5;

function baseScanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

function baseScanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

function shortAddr(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function toNum(value: string | number | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

type AutoTab = 'launch' | 'lp' | 'history';

const AUTO_TABS: AutoTab[] = ['launch', 'lp', 'history'];

const MANUAL_BUY_STATUSES: TokenLaunchStatus[] = ['monitoring', 'buying'];

const ACTIVE_LAUNCH_STATUSES: TokenLaunchStatus[] = [
  'pending',
  'deploying',
  'adding_liquidity',
  'monitoring',
  'buying',
  'removing_liquidity'
];

function isActiveStatus(status: TokenLaunchStatus): boolean {
  return ACTIVE_LAUNCH_STATUSES.includes(status);
}

function launchBadge(status: TokenLaunchStatus): { label: string; cls: string } {
  if (status === 'completed') return { label: 'completed', cls: 'pill success' };
  if (status === 'failed') return { label: 'failed', cls: 'pill danger' };
  return { label: status.replace(/_/g, ' '), cls: 'pill live' };
}

function canManualBuy(job: TokenLaunchJob): boolean {
  return MANUAL_BUY_STATUSES.includes(job.status) && Boolean(job.tokenAddress) && Boolean(job.poolAddress);
}

function canFinish(job: TokenLaunchJob): boolean {
  return isActiveStatus(job.status);
}

function jobUsesWallet3(job: TokenLaunchJob): boolean {
  return job.input.useWallet3 === true;
}

type WalletView = {
  index: 1 | 2 | 3;
  role: string;
  address?: string;
  balance?: string;
  need: number;
  configured: boolean;
  optional?: boolean;
};

function WalletRow({ wallet }: { wallet: WalletView }) {
  const balance = wallet.balance != null ? Number(wallet.balance) : NaN;
  const status: 'ok' | 'warn' | 'off' = !wallet.configured
    ? 'off'
    : Number.isFinite(balance) && wallet.need > 0 && balance + 1e-9 < wallet.need
      ? 'warn'
      : 'ok';

  return (
    <div className="tl-wrow">
      <span className={`tl-dot ${status}`} aria-hidden />
      <div className="tl-wrow-body">
        <div className="tl-wrow-top">
          <span className="tl-wrow-role">
            W{wallet.index} · {wallet.role}
          </span>
          {wallet.configured && wallet.address && (
            <a
              className="tl-wrow-addr"
              href={baseScanAddress(wallet.address)}
              target="_blank"
              rel="noreferrer"
            >
              {shortAddr(wallet.address)}
            </a>
          )}
        </div>
        {wallet.configured ? (
          <p className="tl-wrow-bal">
            <span className="tl-wrow-amount">{wallet.balance ?? '—'}</span>
            <span className="tl-unit-sm">ETH</span>
            {wallet.need > 0 && (
              <span className={`tl-wrow-need${status === 'warn' ? ' warn' : ''}`}>
                {status === 'warn' ? 'low · ' : ''}need {wallet.need.toFixed(4)}
              </span>
            )}
          </p>
        ) : (
          <p className="tl-wrow-off">
            {wallet.optional ? 'Optional · set WALLET_3_PRIVATE_KEY' : 'Not configured'}
          </p>
        )}
      </div>
    </div>
  );
}

export function TokenLaunchPage({
  jobs,
  reloadJobs
}: {
  jobs: TokenLaunchJob[];
  reloadJobs: () => Promise<void>;
}) {
  const [configured, setConfigured] = useState(false);
  const [wallet1Address, setWallet1Address] = useState<string>();
  const [wallet2Address, setWallet2Address] = useState<string>();
  const [wallet3Address, setWallet3Address] = useState<string>();
  const [wallet1BalanceEth, setWallet1BalanceEth] = useState<string>();
  const [wallet2BalanceEth, setWallet2BalanceEth] = useState<string>();
  const [wallet3BalanceEth, setWallet3BalanceEth] = useState<string>();
  const [wallet3Configured, setWallet3Configured] = useState(false);
  const [rpcUrl, setRpcUrl] = useState('https://mainnet.base.org');
  const [input, setInput] = useState<TokenLaunchInput>(DEFAULT_INPUT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unremovedLp, setUnremovedLp] = useState<UnremovedLpPosition[]>([]);
  const [lpLoading, setLpLoading] = useState(false);
  const [lpBusyPool, setLpBusyPool] = useState<string | null>(null);
  const [lpRemovingAll, setLpRemovingAll] = useState(false);
  const [lpError, setLpError] = useState<string | null>(null);
  const [lpNotice, setLpNotice] = useState<string | null>(null);
  const [manualBuyBusy, setManualBuyBusy] = useState<string | null>(null);
  const [manualBuyError, setManualBuyError] = useState<string | null>(null);
  const [finishBusy, setFinishBusy] = useState<string | null>(null);
  const [finishError, setFinishError] = useState<string | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [tab, setTab] = useState<AutoTab>('launch');

  const hasActiveJob = jobs.some((job) => isActiveStatus(job.status));

  const historyPageCount = Math.max(1, Math.ceil(jobs.length / HISTORY_PAGE_SIZE));
  const currentHistoryPage = Math.min(historyPage, historyPageCount);
  const pagedJobs = useMemo(
    () => jobs.slice((currentHistoryPage - 1) * HISTORY_PAGE_SIZE, currentHistoryPage * HISTORY_PAGE_SIZE),
    [jobs, currentHistoryPage]
  );

  useEffect(() => {
    if (historyPage > historyPageCount) setHistoryPage(historyPageCount);
  }, [historyPage, historyPageCount]);

  const reloadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await getTokenLaunchStatus();
      setConfigured(status.configured);
      setWallet1Address(status.wallet1Address);
      setWallet2Address(status.wallet2Address);
      setWallet3Address(status.wallet3Address);
      setWallet1BalanceEth(status.wallet1BalanceEth);
      setWallet2BalanceEth(status.wallet2BalanceEth);
      setWallet3BalanceEth(status.wallet3BalanceEth);
      setWallet3Configured(Boolean(status.wallet3Configured));
      setRpcUrl(status.rpcUrl);
    } catch (err) {
      setConfigured(false);
      setError(err instanceof Error ? err.message : 'Failed to load token launch status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => {
      void reloadJobs();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, reloadJobs]);

  const updateInput = (field: keyof TokenLaunchInput, value: string | number | boolean) => {
    setInput((current) => ({ ...current, [field]: value }));
  };

  const reloadUnremovedLp = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!configured) return;
      // Silent mode (used after a removal) refreshes the list in place without the "Scanning…"
      // spinner that blanks the panel, and without clobbering the removal result notice on error.
      const silent = options?.silent ?? false;
      if (!silent) {
        setLpLoading(true);
        setLpError(null);
      }
      try {
        setUnremovedLp(await getUnremovedLp());
      } catch (err) {
        if (!silent) {
          setUnremovedLp([]);
          setLpError(err instanceof Error ? err.message : 'Failed to scan wallet LP');
        }
      } finally {
        if (!silent) setLpLoading(false);
      }
    },
    [configured]
  );

  useEffect(() => {
    if (configured) void reloadUnremovedLp();
  }, [configured, reloadUnremovedLp]);

  const summarizeRemoval = (results: LpRemovalResult[]): string => {
    const ok = results.filter((result) => result.success).length;
    const failed = results.length - ok;
    if (failed === 0) return `Removed LP from ${ok} pool${ok === 1 ? '' : 's'}.`;
    return `Removed ${ok} pool${ok === 1 ? '' : 's'}, ${failed} failed.`;
  };

  // Drop pools that were removed successfully so they disappear from the list right away,
  // instead of waiting on (and blanking the panel for) a full on-chain rescan.
  const dropRemovedPools = (results: LpRemovalResult[]) => {
    const removed = new Set(results.filter((r) => r.success).map((r) => r.poolAddress.toLowerCase()));
    if (removed.size === 0) return;
    setUnremovedLp((current) => current.filter((p) => !removed.has(p.poolAddress.toLowerCase())));
  };

  // Show the reason for any pool that failed to remove, not just a "N failed" count.
  const showRemovalErrors = (results: LpRemovalResult[]) => {
    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) return;
    setLpError(failed.map((r) => r.error?.trim() || 'Unknown error').join(' · '));
  };

  const removeOneLp = async (poolAddress: string) => {
    setLpBusyPool(poolAddress);
    setLpError(null);
    setLpNotice(null);
    try {
      const results = await removeUnremovedLp({ poolAddress });
      setLpNotice(summarizeRemoval(results));
      showRemovalErrors(results);
      dropRemovedPools(results);
      void reloadUnremovedLp({ silent: true });
      void reloadJobs();
    } catch (err) {
      setLpError(err instanceof Error ? err.message : 'Failed to remove LP');
    } finally {
      setLpBusyPool(null);
    }
  };

  const removeAllLp = async () => {
    setLpRemovingAll(true);
    setLpError(null);
    setLpNotice(null);
    try {
      const results = await removeUnremovedLp({ all: true });
      setLpNotice(results.length === 0 ? 'No stranded LP found on wallet 1.' : summarizeRemoval(results));
      showRemovalErrors(results);
      dropRemovedPools(results);
      void reloadUnremovedLp({ silent: true });
      void reloadJobs();
    } catch (err) {
      setLpError(err instanceof Error ? err.message : 'Failed to remove all LP');
    } finally {
      setLpRemovingAll(false);
    }
  };

  const wallet2BuyAmount = (job: TokenLaunchJob) =>
    job.input.wallet2BuyEthAmount?.trim() || job.input.buyEthAmount;

  const finishLaunch = async (job: TokenLaunchJob) => {
    setFinishBusy(job.jobId);
    setFinishError(null);
    try {
      await finishTokenLaunch(job.jobId);
      await reloadJobs();
    } catch (err) {
      setFinishError(err instanceof Error ? err.message : 'Failed to finish launch');
    } finally {
      setFinishBusy(null);
    }
  };

  const manualBuy = async (job: TokenLaunchJob, wallet: 2 | 3) => {
    const busyKey = `${job.jobId}:${wallet}`;
    setManualBuyBusy(busyKey);
    setManualBuyError(null);
    try {
      await manualTokenLaunchBuy(job.jobId, wallet);
      await reloadJobs();
    } catch (err) {
      setManualBuyError(err instanceof Error ? err.message : `Wallet ${wallet} buy failed`);
    } finally {
      setManualBuyBusy(null);
    }
  };

  const launch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await startTokenLaunch(input);
      await reloadJobs();
      const repeatLabel =
        input.repeatCount > 1 ? `${input.repeatCount} launches queued sequentially.` : 'Launch started.';
      setNotice(`${repeatLabel} Token "${input.tokenName}".`);
      setTab('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start token launch');
    } finally {
      setBusy(false);
    }
  };

  const wallet2Need = toNum(input.wallet2BuyEthAmount ?? input.buyEthAmount) + BUY_GAS_BUFFER;
  const wallet3Need = input.useWallet3 ? toNum(input.buyEthAmount) + BUY_GAS_BUFFER : 0;
  const wallet1Need = toNum(input.lpEthAmount) + W1_GAS_BUFFER;

  const wallets: WalletView[] = [
    {
      index: 1,
      role: 'Deploy + LP',
      address: wallet1Address,
      balance: wallet1BalanceEth,
      need: wallet1Need,
      configured
    },
    {
      index: 2,
      role: 'Buyer',
      address: wallet2Address,
      balance: wallet2BalanceEth,
      need: wallet2Need,
      configured
    },
    {
      index: 3,
      role: 'Buyer · optional',
      address: wallet3Address,
      balance: wallet3BalanceEth,
      need: wallet3Need,
      configured: wallet3Configured,
      optional: true
    }
  ];

  const tabLabel = (key: AutoTab): string => {
    if (key === 'launch') return 'New launch';
    if (key === 'lp') return unremovedLp.length > 0 ? `Stranded LP (${unremovedLp.length})` : 'Stranded LP';
    return jobs.length > 0 ? `Launches (${jobs.length})` : 'Launches';
  };

  const submitLabel = busy
    ? 'Starting…'
    : hasActiveJob
      ? input.repeatCount > 1
        ? 'Batch in progress…'
        : 'Launch in progress…'
      : input.repeatCount > 1
        ? `Start ${input.repeatCount} launches`
        : `Start launch on ${dexLabel(input.dex)}`;

  return (
    <main className="page tl-page tl-layout">
      <div className="tl-main">
        <header className="tl-head">
          <div>
            <p className="eyebrow">Robinhood · {dexLabel(input.dex)}</p>
            <h1>Auto Launch</h1>
          </div>
          <div className="tl-dex-toggle" role="tablist" aria-label="Auto launch section">
            {AUTO_TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`tl-dex-option${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                {tabLabel(key)}
              </button>
            ))}
          </div>
        </header>

        {!loading && !configured && (
          <section className="detail-panel tl-config-warning">
            <strong>Wallets not configured.</strong>
            <p className="subtle" style={{ margin: '6px 0 0' }}>
              Set <span className="mono">WALLET_1_PRIVATE_KEY</span> and <span className="mono">WALLET_2_PRIVATE_KEY</span>{' '}
              in <span className="mono">backend/.env</span>, then restart the backend.
            </p>
          </section>
        )}

      {tab === 'launch' && (
      <section className="detail-panel tl-form-card">
        <div className="tl-section-head">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            New launch
          </h2>
          <div className="tl-dex-toggle" role="group" aria-label="DEX">
            {DEX_ORDER.map((dex) => (
              <button
                key={dex}
                type="button"
                className={`tl-dex-option${input.dex === dex ? ' active' : ''}`}
                onClick={() => updateInput('dex', dex)}
                disabled={busy || hasActiveJob}
              >
                {DEX_LABELS[dex]}
              </button>
            ))}
          </div>
        </div>

        <form className="tl-form" onSubmit={launch}>
          <fieldset className="tl-fieldset">
            <legend className="tl-legend">Token</legend>
            <div className="tl-grid">
              <div className="tl-field">
                <label htmlFor="tl-name">Name</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-name"
                    className="tl-input"
                    value={input.tokenName}
                    onChange={(e) => updateInput('tokenName', e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="tl-field">
                <label htmlFor="tl-symbol">Symbol</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-symbol"
                    className="tl-input"
                    value={input.tokenSymbol}
                    onChange={(e) => updateInput('tokenSymbol', e.target.value)}
                    required
                  />
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset className="tl-fieldset">
            <legend className="tl-legend">Liquidity &amp; buys</legend>
            <div className="tl-grid">
              <div className="tl-field">
                <label htmlFor="tl-lp">LP liquidity</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-lp"
                    className="tl-input"
                    inputMode="decimal"
                    value={input.lpEthAmount}
                    onChange={(e) => updateInput('lpEthAmount', e.target.value)}
                    required
                  />
                  <span className="tl-unit">ETH</span>
                </div>
              </div>
              <div className="tl-field">
                <label htmlFor="tl-w2buy">Wallet 2 buy</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-w2buy"
                    className="tl-input"
                    inputMode="decimal"
                    value={input.wallet2BuyEthAmount}
                    onChange={(e) => updateInput('wallet2BuyEthAmount', e.target.value)}
                    required
                  />
                  <span className="tl-unit">ETH</span>
                </div>
              </div>
              {input.useWallet3 && (
                <div className="tl-field">
                  <label htmlFor="tl-w3buy">Wallet 3 buy</label>
                  <div className="tl-input-wrap">
                    <input
                      id="tl-w3buy"
                      className="tl-input"
                      inputMode="decimal"
                      value={input.buyEthAmount}
                      onChange={(e) => updateInput('buyEthAmount', e.target.value)}
                      required
                    />
                    <span className="tl-unit">ETH</span>
                  </div>
                </div>
              )}
              <div className="tl-field">
                <label htmlFor="tl-after">Own buy after</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-after"
                    className="tl-input"
                    type="number"
                    min={1}
                    max={3600}
                    step={1}
                    value={input.buyAfterSeconds}
                    onChange={(e) =>
                      updateInput('buyAfterSeconds', Math.max(1, Number.parseInt(e.target.value, 10) || 30))
                    }
                    required
                  />
                  <span className="tl-unit">sec</span>
                </div>
              </div>
            </div>
            <label className={`tl-toggle tl-span-2${!wallet3Configured ? ' disabled' : ''}`}>
              <input
                type="checkbox"
                checked={input.useWallet3}
                disabled={!wallet3Configured}
                onChange={(e) => updateInput('useWallet3', e.target.checked)}
              />
              <span>
                Use wallet 3 for buys
                {!wallet3Configured && <span className="subtle"> · set WALLET_3_PRIVATE_KEY first</span>}
              </span>
            </label>
          </fieldset>

          <fieldset className="tl-fieldset">
            <legend className="tl-legend">Exit &amp; repeat</legend>
            <div className="tl-grid">
              <div className="tl-field">
                <label htmlFor="tl-minbuyers">Min buyers to exit</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-minbuyers"
                    className="tl-input"
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={input.minBuyersBeforeRemoveLp}
                    onChange={(e) =>
                      updateInput('minBuyersBeforeRemoveLp', Math.max(1, Number.parseInt(e.target.value, 10) || 1))
                    }
                    required
                  />
                </div>
              </div>
              <div className="tl-field">
                <label htmlFor="tl-removetime">Remove LP after</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-removetime"
                    className="tl-input"
                    type="number"
                    min={1}
                    max={180}
                    step={1}
                    value={input.removeLpTimeMinutes}
                    onChange={(e) =>
                      updateInput('removeLpTimeMinutes', Math.max(1, Number.parseInt(e.target.value, 10) || 1))
                    }
                    required
                  />
                  <span className="tl-unit">min</span>
                </div>
              </div>
              <div className="tl-field">
                <label htmlFor="tl-repeat">Repeat count</label>
                <div className="tl-input-wrap">
                  <input
                    id="tl-repeat"
                    className="tl-input"
                    type="number"
                    min={1}
                    max={50}
                    step={1}
                    value={input.repeatCount}
                    onChange={(e) => updateInput('repeatCount', Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
                    required
                  />
                </div>
              </div>
            </div>
            <label className="tl-toggle tl-span-2">
              <input
                type="checkbox"
                checked={input.removeLp}
                onChange={(e) => updateInput('removeLp', e.target.checked)}
              />
              <span>Remove LP automatically when min buyers met or after the timeout</span>
            </label>
          </fieldset>

          <button
            type="submit"
            className="button tl-cta"
            disabled={!configured || busy || hasActiveJob || (input.useWallet3 && !wallet3Configured)}
          >
            {submitLabel}
          </button>
        </form>

        {hasActiveJob && !busy && (
          <p className="subtle" style={{ marginTop: 12 }}>
            A launch batch is running — wait for it to finish before starting another.
          </p>
        )}
        {notice && <p className="result">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>
      )}

      {tab === 'lp' && (
      <section className="detail-panel">
        <div className="card-title-row">
          <h2 className="section-title">Stranded LP</h2>
          <button
            type="button"
            className="button secondary"
            onClick={() => void reloadUnremovedLp()}
            disabled={!configured || lpLoading || lpRemovingAll || Boolean(lpBusyPool)}
          >
            {lpLoading ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        <p className="subtle">
          Aerodrome &amp; Uniswap LP still held by wallet&nbsp;1. Available anytime, including during an active launch.
        </p>
        {lpLoading ? (
          <p className="subtle">Scanning on-chain LP balances…</p>
        ) : unremovedLp.length === 0 ? (
          <p className="subtle">No stranded LP detected.</p>
        ) : (
          <>
            <div className="order-list">
              {unremovedLp.map((position) => (
                <article key={position.poolAddress} className="tl-launch-card">
                  <div className="tl-launch-head">
                    <div>
                      <span className="tl-launch-title">
                        {position.tokenName || 'Token'} <span className="tl-launch-sym">({position.tokenSymbol || '???'})</span>
                      </span>
                      <p className="tl-meta-row">LP balance {position.lpBalance}</p>
                    </div>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={lpRemovingAll || lpBusyPool === position.poolAddress}
                      onClick={() => void removeOneLp(position.poolAddress)}
                    >
                      {lpBusyPool === position.poolAddress ? 'Removing…' : 'Remove LP'}
                    </button>
                  </div>
                  <div className="tl-chips">
                    <span className="tl-chip accent">{dexLabel(position.dex)}</span>
                    <a className="tl-chip" href={baseScanAddress(position.poolAddress)} target="_blank" rel="noreferrer">
                      pool {shortId(position.poolAddress)}
                    </a>
                    <a className="tl-chip" href={baseScanAddress(position.tokenAddress)} target="_blank" rel="noreferrer">
                      token {shortId(position.tokenAddress)}
                    </a>
                    {position.jobIds.length > 0 && (
                      <span className="tl-chip">{position.jobIds.length} job{position.jobIds.length === 1 ? '' : 's'}</span>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <button
              type="button"
              className="button"
              style={{ marginTop: 14 }}
              disabled={!configured || lpRemovingAll || Boolean(lpBusyPool)}
              onClick={() => void removeAllLp()}
            >
              {lpRemovingAll ? 'Removing all…' : `Remove all (${unremovedLp.length})`}
            </button>
          </>
        )}
        {lpNotice && <p className="result">{lpNotice}</p>}
        {lpError && <p className="error">{lpError}</p>}
      </section>
      )}

      {tab === 'history' && (
      <>
      {(manualBuyError || finishError) && (
        <p className="error page-banner-error" style={{ marginBottom: 12 }}>
          {manualBuyError || finishError}
        </p>
      )}

      <section>
        <div className="card-title-row" style={{ marginBottom: 14 }}>
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            Recent launches
          </h2>
          <Link to="/orders" className="back-link" style={{ marginBottom: 0 }}>
            All activity →
          </Link>
        </div>
        {jobs.length === 0 ? (
          <div className="empty small">No token launches yet — fill the form above to start one.</div>
        ) : (
          <div className="order-list">
            {pagedJobs.map((job) => {
              const badge = launchBadge(job.status);
              const txChips: { label: string; hash: string }[] = [
                ...(job.deployTxHash ? [{ label: 'deploy', hash: job.deployTxHash }] : []),
                ...(job.addLiquidityTxHash ? [{ label: 'add LP', hash: job.addLiquidityTxHash }] : []),
                ...(job.buyTxHash ? [{ label: 'W2 buy', hash: job.buyTxHash }] : []),
                ...(job.wallet3BuyTxHash ? [{ label: 'W3 buy', hash: job.wallet3BuyTxHash }] : []),
                ...(job.removeLiquidityTxHash ? [{ label: 'remove LP', hash: job.removeLiquidityTxHash }] : [])
              ];
              return (
                <article key={job.jobId} className="tl-launch-card">
                  <div className="tl-launch-head">
                    <div>
                      <span className="tl-launch-title">
                        {job.input.tokenName} <span className="tl-launch-sym">({job.input.tokenSymbol})</span>
                        {job.repeatTotal && job.repeatTotal > 1 && job.repeatIndex
                          ? ` · ${job.repeatIndex}/${job.repeatTotal}`
                          : ''}
                      </span>
                      <p className="tl-meta-row">
                        Job {shortId(job.jobId)} · {formatRelativeTime(job.updatedAt)}
                      </p>
                    </div>
                    <span className={badge.cls}>{badge.label}</span>
                  </div>

                  <div className="tl-chips">
                    <span className="tl-chip accent">{dexLabel(job.input.dex)}</span>
                    <span className="tl-chip">{job.input.lpEthAmount} Ξ LP</span>
                    <span className="tl-chip">seen {job.buyerCount}</span>
                    <span className="tl-chip">min {job.input.minBuyersBeforeRemoveLp ?? 1}</span>
                    {job.input.removeLp === false ? (
                      <span className="tl-chip">LP kept</span>
                    ) : (
                      <span className="tl-chip">{job.input.removeLpTimeMinutes ?? 5}m exit</span>
                    )}
                    {jobUsesWallet3(job) && <span className="tl-chip">W3 on</span>}
                  </div>

                  {job.phase && <p className="tl-phase">{job.phase}</p>}

                  {(canManualBuy(job) || canFinish(job)) && (
                    <div className="launch-buy-actions">
                      {canManualBuy(job) && (
                        <>
                          <button
                            type="button"
                            className="button secondary"
                            disabled={Boolean(manualBuyBusy) || Boolean(finishBusy)}
                            onClick={() => void manualBuy(job, 2)}
                          >
                            {manualBuyBusy === `${job.jobId}:2`
                              ? 'Buying…'
                              : `Buy W2 (${wallet2BuyAmount(job)} ETH)`}
                          </button>
                          {jobUsesWallet3(job) && (
                            <button
                              type="button"
                              className="button secondary"
                              disabled={Boolean(manualBuyBusy) || Boolean(finishBusy)}
                              onClick={() => void manualBuy(job, 3)}
                            >
                              {manualBuyBusy === `${job.jobId}:3`
                                ? 'Buying…'
                                : `Buy W3 (${job.input.buyEthAmount} ETH)`}
                            </button>
                          )}
                        </>
                      )}
                      {canFinish(job) && (
                        <button
                          type="button"
                          className="button secondary danger-outline"
                          disabled={Boolean(manualBuyBusy) || finishBusy === job.jobId}
                          onClick={() => void finishLaunch(job)}
                        >
                          {finishBusy === job.jobId ? 'Finishing…' : 'Finish'}
                        </button>
                      )}
                    </div>
                  )}

                  {(job.tokenAddress || txChips.length > 0) && (
                    <div className="tl-chips tl-tx-chips">
                      {job.tokenAddress && (
                        <a className="tl-chip" href={baseScanAddress(job.tokenAddress)} target="_blank" rel="noreferrer">
                          token {shortId(job.tokenAddress)}
                        </a>
                      )}
                      {job.poolAddress && (
                        <a className="tl-chip" href={baseScanAddress(job.poolAddress)} target="_blank" rel="noreferrer">
                          pool {shortId(job.poolAddress)}
                        </a>
                      )}
                      {txChips.map((tx) => (
                        <a
                          key={tx.label}
                          className="tl-chip"
                          href={baseScanTx(tx.hash)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {tx.label} {shortId(tx.hash)}
                        </a>
                      ))}
                    </div>
                  )}

                  {job.tokenAddress && job.poolAddress && (
                    <p style={{ marginTop: 12 }}>
                      <Link to={`/tokenlaunch/${job.jobId}`} className="back-link" style={{ marginBottom: 0 }}>
                        View analyzer
                        {job.trades && job.trades.length > 0 ? ` (${job.trades.length} trades)` : ''}
                      </Link>
                    </p>
                  )}

                  {job.error && <p className="error">{job.error}</p>}
                </article>
              );
            })}
          </div>
        )}
        {historyPageCount > 1 && (
          <div className="tl-pager">
            <button
              type="button"
              className="button secondary"
              disabled={currentHistoryPage <= 1}
              onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
            >
              ← Prev
            </button>
            <span className="tl-pager-info">
              Page {currentHistoryPage} / {historyPageCount}
              <span className="subtle"> · {jobs.length} total</span>
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={currentHistoryPage >= historyPageCount}
              onClick={() => setHistoryPage((page) => Math.min(historyPageCount, page + 1))}
            >
              Next →
            </button>
          </div>
        )}
      </section>
      </>
      )}
      </div>

      <aside className="tl-sidebar">
        <div className="tl-side-card">
          <div className="tl-side-head">
            <span className="tl-side-title">Wallets</span>
            <button
              type="button"
              className="tl-side-refresh"
              onClick={() => void reloadStatus()}
              disabled={loading}
              aria-label="Refresh balances"
            >
              {loading ? '…' : '↻'}
            </button>
          </div>
          {loading ? (
            <div className="tl-wrows">
              <div className="tl-wrow tl-skeleton" />
              <div className="tl-wrow tl-skeleton" />
              <div className="tl-wrow tl-skeleton" />
            </div>
          ) : configured ? (
            <div className="tl-wrows">
              {wallets.map((wallet) => (
                <WalletRow key={wallet.index} wallet={wallet} />
              ))}
            </div>
          ) : (
            <p className="tl-wrow-off">Set wallet keys in backend/.env to see balances.</p>
          )}
          {configured && <p className="tl-side-rpc mono">RPC · {rpcUrl}</p>}
        </div>
      </aside>
    </main>
  );
}
