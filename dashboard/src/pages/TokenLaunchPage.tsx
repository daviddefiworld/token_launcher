import { useCallback, useEffect, useState } from 'react';
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
import type { LpRemovalResult, TokenLaunchJob, TokenLaunchStatus, UnremovedLpPosition } from '../types';
import { formatRelativeTime, shortId } from '../utils';

const DEFAULT_INPUT: TokenLaunchInput = {
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

function launchStatusClass(status: TokenLaunchStatus): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed') return 'pill danger';
  return 'pill muted';
}

function baseScanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

function baseScanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

const MANUAL_BUY_STATUSES: TokenLaunchStatus[] = ['monitoring', 'buying'];

const ACTIVE_LAUNCH_STATUSES: TokenLaunchStatus[] = [
  'pending',
  'deploying',
  'adding_liquidity',
  'monitoring',
  'buying',
  'removing_liquidity'
];

function canManualBuy(job: TokenLaunchJob): boolean {
  return MANUAL_BUY_STATUSES.includes(job.status) && Boolean(job.tokenAddress) && Boolean(job.poolAddress);
}

function canFinish(job: TokenLaunchJob): boolean {
  return ACTIVE_LAUNCH_STATUSES.includes(job.status);
}

function jobUsesWallet3(job: TokenLaunchJob): boolean {
  return job.input.useWallet3 === true;
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

  const hasActiveJob = jobs.some((job) =>
    ['pending', 'deploying', 'adding_liquidity', 'monitoring', 'buying', 'removing_liquidity'].includes(job.status)
  );

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

  const reloadUnremovedLp = useCallback(async () => {
    if (!configured) return;
    setLpLoading(true);
    setLpError(null);
    try {
      setUnremovedLp(await getUnremovedLp());
    } catch (err) {
      setUnremovedLp([]);
      setLpError(err instanceof Error ? err.message : 'Failed to scan wallet LP');
    } finally {
      setLpLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    if (configured) void reloadUnremovedLp();
  }, [configured, reloadUnremovedLp]);

  const summarizeRemoval = (results: LpRemovalResult[]): string => {
    const ok = results.filter((result) => result.success).length;
    const failed = results.length - ok;
    if (failed === 0) return `Removed LP from ${ok} pool${ok === 1 ? '' : 's'}.`;
    return `Removed ${ok} pool${ok === 1 ? '' : 's'}, ${failed} failed.`;
  };

  const removeOneLp = async (poolAddress: string) => {
    setLpBusyPool(poolAddress);
    setLpError(null);
    setLpNotice(null);
    try {
      const results = await removeUnremovedLp({ poolAddress });
      await reloadUnremovedLp();
      await reloadJobs();
      setLpNotice(summarizeRemoval(results));
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
      await reloadUnremovedLp();
      await reloadJobs();
      setLpNotice(results.length === 0 ? 'No stranded LP found on wallet 1.' : summarizeRemoval(results));
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start token launch');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page narrow">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Base · Aerodrome</p>
          <h1>Token Launch</h1>
          <p className="subtle">
            Deploy a token, add LP with wallet 1, monitor buyers, optionally buy with wallets 2 and/or 3 after your delay,
            then remove LP after your chosen timeout (optional — disable auto-remove to clean up later from stranded LP).
          </p>
        </div>
        <button type="button" onClick={() => void reloadStatus()} className="button secondary" disabled={loading}>
          Refresh
        </button>
      </div>

      <section className="detail-panel">
        <h2 className="section-title">Wallet setup</h2>
        {loading ? (
          <p className="subtle">Loading configuration...</p>
        ) : configured ? (
          <>
            <p className="subtle">RPC: {rpcUrl}</p>
            <p className="mono subtle">
              Wallet 1 (deploy + LP): {wallet1Address}
              {wallet1BalanceEth ? ` · ${wallet1BalanceEth} ETH` : ''}
            </p>
            <p className="mono subtle">
              Wallet 2 (buy): {wallet2Address}
              {wallet2BalanceEth ? ` · ${wallet2BalanceEth} ETH` : ''}
            </p>
            <p className="mono subtle">
              Wallet 3 (optional buy):{' '}
              {wallet3Configured ? wallet3Address : 'not configured — set WALLET_3_PRIVATE_KEY to enable'}
              {wallet3Configured && wallet3BalanceEth ? ` · ${wallet3BalanceEth} ETH` : ''}
            </p>
          </>
        ) : (
          <p className="error">
            Set WALLET_1_PRIVATE_KEY and WALLET_2_PRIVATE_KEY in backend/.env, then restart the backend.
          </p>
        )}
      </section>

      <section className="detail-panel">
        <h2 className="section-title">Launch control</h2>
        <form className="withdraw-form" onSubmit={launch}>
          <label>
            Token name
            <input value={input.tokenName} onChange={(e) => updateInput('tokenName', e.target.value)} required />
          </label>
          <label>
            Token symbol
            <input value={input.tokenSymbol} onChange={(e) => updateInput('tokenSymbol', e.target.value)} required />
          </label>
          <label>
            LP ETH amount
            <input value={input.lpEthAmount} onChange={(e) => updateInput('lpEthAmount', e.target.value)} required />
          </label>
          <label>
            Wallet 2 buy amount (ETH)
            <input
              value={input.wallet2BuyEthAmount}
              onChange={(e) => updateInput('wallet2BuyEthAmount', e.target.value)}
              required
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={input.useWallet3}
              disabled={!wallet3Configured}
              onChange={(e) => updateInput('useWallet3', e.target.checked)}
            />
            Use wallet 3 for buys
            {!wallet3Configured && <span className="subtle"> (set WALLET_3_PRIVATE_KEY first)</span>}
          </label>
          {input.useWallet3 && (
            <label>
              Wallet 3 buy amount (ETH)
              <input
                value={input.buyEthAmount}
                onChange={(e) => updateInput('buyEthAmount', e.target.value)}
                required
              />
            </label>
          )}
          <label>
            Own buy after (seconds)
            <input
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
          </label>
          <p className="subtle">
            If no external buyers within this time, wallet 2{input.useWallet3 ? ' and wallet 3' : ''} buy automatically.
          </p>
          <label>
            Repeat count
            <input
              type="number"
              min={1}
              max={50}
              step={1}
              value={input.repeatCount}
              onChange={(e) => updateInput('repeatCount', Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
              required
            />
          </label>
          <label>
            Remove LP after (minutes)
            <input
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
          </label>
          <label>
            Min buyers before remove LP
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={input.minBuyersBeforeRemoveLp}
              onChange={(e) =>
                updateInput(
                  'minBuyersBeforeRemoveLp',
                  Math.max(1, Number.parseInt(e.target.value, 10) || 1)
                )
              }
              required
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={input.removeLp}
              onChange={(e) => updateInput('removeLp', e.target.checked)}
            />
            Remove LP automatically (when min buyers met or after timeout above)
          </label>
          <button
            type="submit"
            className="button"
            disabled={!configured || busy || hasActiveJob || (input.useWallet3 && !wallet3Configured)}
          >
            {busy
              ? 'Starting...'
              : hasActiveJob
                ? input.repeatCount > 1
                  ? 'Batch in progress...'
                  : 'Launch in progress...'
                : input.repeatCount > 1
                  ? `Start ${input.repeatCount} launches`
                  : 'Start token launch'}
          </button>
        </form>
        {hasActiveJob && !busy && (
          <p className="subtle">
            A launch batch is running. Wait for all repeats to finish before starting another.
          </p>
        )}
        {notice && <p className="result">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="detail-panel">
        <div className="card-title-row">
          <h2 className="section-title">Stranded LP (wallet 1)</h2>
          <button
            type="button"
            className="button secondary"
            onClick={() => void reloadUnremovedLp()}
            disabled={!configured || lpLoading || lpRemovingAll || Boolean(lpBusyPool)}
          >
            {lpLoading ? 'Scanning...' : 'Refresh'}
          </button>
        </div>
        <p className="subtle">
          Aerodrome LP still held by wallet 1. Available anytime, including during an active launch.
        </p>
        {lpLoading ? (
          <p className="subtle">Scanning on-chain LP balances...</p>
        ) : unremovedLp.length === 0 ? (
          <p className="subtle">No stranded LP detected.</p>
        ) : (
          <>
            <div className="order-list">
              {unremovedLp.map((position) => (
                <article key={position.poolAddress} className="order-card">
                  <div className="card-title-row">
                    <strong>
                      {position.tokenName || 'Token'} ({position.tokenSymbol || '???'})
                    </strong>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={lpRemovingAll || lpBusyPool === position.poolAddress}
                      onClick={() => void removeOneLp(position.poolAddress)}
                    >
                      {lpBusyPool === position.poolAddress ? 'Removing...' : 'Remove LP'}
                    </button>
                  </div>
                  <p className="subtle mono">
                    Pool:{' '}
                    <a href={baseScanAddress(position.poolAddress)} target="_blank" rel="noreferrer">
                      {shortId(position.poolAddress)}
                    </a>
                  </p>
                  <p className="subtle mono">
                    Token:{' '}
                    <a href={baseScanAddress(position.tokenAddress)} target="_blank" rel="noreferrer">
                      {shortId(position.tokenAddress)}
                    </a>
                  </p>
                  <p className="subtle mono">LP balance: {position.lpBalance}</p>
                  {position.jobIds.length > 0 && (
                    <p className="subtle mono">Jobs: {position.jobIds.map(shortId).join(', ')}</p>
                  )}
                </article>
              ))}
            </div>
            <button
              type="button"
              className="button"
              style={{ marginTop: 12 }}
              disabled={!configured || lpRemovingAll || Boolean(lpBusyPool)}
              onClick={() => void removeAllLp()}
            >
              {lpRemovingAll ? 'Removing all...' : `Remove all (${unremovedLp.length})`}
            </button>
          </>
        )}
        {lpNotice && <p className="result">{lpNotice}</p>}
        {lpError && <p className="error">{lpError}</p>}
      </section>

      {(manualBuyError || finishError) && (
        <p className="error page-banner-error" style={{ marginBottom: 12 }}>
          {manualBuyError || finishError}
        </p>
      )}

      <section>
        <h2 className="section-title">Recent launches</h2>
        {jobs.length === 0 ? (
          <div className="empty small">No token launches yet.</div>
        ) : (
          <div className="order-list">
            {jobs.map((job) => (
              <article key={job.jobId} className="order-card">
                <div className="card-title-row">
                  <strong>
                    {job.input.tokenName} ({job.input.tokenSymbol})
                    {job.repeatTotal && job.repeatTotal > 1 && job.repeatIndex
                      ? ` · ${job.repeatIndex}/${job.repeatTotal}`
                      : ''}
                  </strong>
                  <span className={launchStatusClass(job.status)}>{job.status}</span>
                </div>
                <p className="subtle order-summary">
                  {job.input.lpEthAmount} ETH LP · own buy after {job.input.buyAfterSeconds ?? 30}s ·{' '}
                  {job.input.removeLpTimeMinutes ?? 5} min · min {job.input.minBuyersBeforeRemoveLp ?? 1} buyers · seen{' '}
                  {job.buyerCount}
                  {jobUsesWallet3(job) ? ' · W3 on' : ''}
                  {job.input.removeLp === false ? ' · LP kept' : ''}
                  {job.phase ? ` · ${job.phase}` : ''}
                </p>
                <p className="subtle mono">Job {shortId(job.jobId)} · {formatRelativeTime(job.updatedAt)}</p>
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
                            ? 'Buying...'
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
                              ? 'Buying...'
                              : `Buy W3 (${job.input.buyEthAmount} ETH)`}
                          </button>
                        )}
                      </>
                    )}
                    {canFinish(job) && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={Boolean(manualBuyBusy) || finishBusy === job.jobId}
                        onClick={() => void finishLaunch(job)}
                      >
                        {finishBusy === job.jobId ? 'Finishing...' : 'Finish'}
                      </button>
                    )}
                  </div>
                )}
                {job.tokenAddress && job.poolAddress && (
                  <p style={{ marginTop: 10 }}>
                    <Link to={`/tokenlaunch/${job.jobId}`} className="back-link" style={{ marginBottom: 0 }}>
                      View analyzer
                      {job.trades && job.trades.length > 0 ? ` (${job.trades.length} trades)` : ''}
                    </Link>
                  </p>
                )}
                {job.tokenAddress && (
                  <p className="subtle mono">
                    Token:{' '}
                    <a href={baseScanAddress(job.tokenAddress)} target="_blank" rel="noreferrer">
                      {shortId(job.tokenAddress)}
                    </a>
                  </p>
                )}
                {job.poolAddress && (
                  <p className="subtle mono">
                    Pool:{' '}
                    <a href={baseScanAddress(job.poolAddress)} target="_blank" rel="noreferrer">
                      {shortId(job.poolAddress)}
                    </a>
                  </p>
                )}
                {job.deployTxHash && (
                  <p className="subtle mono">
                    Deploy:{' '}
                    <a href={baseScanTx(job.deployTxHash)} target="_blank" rel="noreferrer">
                      {shortId(job.deployTxHash)}
                    </a>
                  </p>
                )}
                {job.addLiquidityTxHash && (
                  <p className="subtle mono">
                    Add LP:{' '}
                    <a href={baseScanTx(job.addLiquidityTxHash)} target="_blank" rel="noreferrer">
                      {shortId(job.addLiquidityTxHash)}
                    </a>
                  </p>
                )}
                {job.buyTxHash && (
                  <p className="subtle mono">
                    Wallet 2 buy:{' '}
                    <a href={baseScanTx(job.buyTxHash)} target="_blank" rel="noreferrer">
                      {shortId(job.buyTxHash)}
                    </a>
                  </p>
                )}
                {job.wallet3BuyTxHash && (
                  <p className="subtle mono">
                    Wallet 3 buy:{' '}
                    <a href={baseScanTx(job.wallet3BuyTxHash)} target="_blank" rel="noreferrer">
                      {shortId(job.wallet3BuyTxHash)}
                    </a>
                  </p>
                )}
                {job.removeLiquidityTxHash && (
                  <p className="subtle mono">
                    Remove LP:{' '}
                    <a href={baseScanTx(job.removeLiquidityTxHash)} target="_blank" rel="noreferrer">
                      {shortId(job.removeLiquidityTxHash)}
                    </a>
                  </p>
                )}
                {job.error && <p className="error">{job.error}</p>}
              </article>
            ))}
          </div>
        )}
        <p className="subtle" style={{ marginTop: 12 }}>
          <Link to="/orders">View all activity</Link>
        </p>
      </section>
    </main>
  );
}
