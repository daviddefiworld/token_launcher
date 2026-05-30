import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getTokenLaunchJobs, getTokenLaunchTrades } from '../api';
import type { PoolTrade, TokenLaunchJob, TokenLaunchTradesResponse } from '../types';
import { formatRelativeTime, shortId } from '../utils';

function baseScanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

function baseScanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

type SideFilter = 'all' | 'buy' | 'sell';
type WalletFilter = 'all' | 'external' | 'own';

export function LaunchAnalyzerPage() {
  const { jobId = '' } = useParams();
  const [job, setJob] = useState<TokenLaunchJob | null>(null);
  const [tradesData, setTradesData] = useState<TokenLaunchTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sideFilter, setSideFilter] = useState<SideFilter>('all');
  const [walletFilter, setWalletFilter] = useState<WalletFilter>('all');

  const load = useCallback(
    async (refresh: boolean) => {
      if (!jobId) return;
      if (refresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const [jobs, trades] = await Promise.all([
          getTokenLaunchJobs(),
          getTokenLaunchTrades(jobId, refresh)
        ]);
        const found = jobs.find((entry) => entry.jobId === jobId) ?? null;
        setJob(found);
        setTradesData(trades);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load launch analyzer');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [jobId]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const filteredTrades = useMemo(() => {
    const trades = tradesData?.trades ?? [];
    return trades.filter((trade) => {
      if (sideFilter !== 'all' && trade.side !== sideFilter) return false;
      if (walletFilter === 'external' && trade.isOwnWallet) return false;
      if (walletFilter === 'own' && !trade.isOwnWallet) return false;
      return true;
    });
  }, [tradesData, sideFilter, walletFilter]);

  if (!jobId) {
    return (
      <main className="page narrow">
        <p className="error">Missing launch job id.</p>
        <Link to="/tokenlaunch" className="back-link">
          ← Token Launch
        </Link>
      </main>
    );
  }

  return (
    <main className="page">
      <Link to="/tokenlaunch" className="back-link">
        ← Token Launch
      </Link>

      {loading ? (
        <div className="empty">Loading analyzer...</div>
      ) : error ? (
        <p className="error">{error}</p>
      ) : (
        <>
          <div className="page-heading">
            <div>
              <p className="eyebrow">Launch analyzer</p>
              <h1>
                {job?.input.tokenName ?? 'Token'} ({job?.input.tokenSymbol ?? '???'})
              </h1>
              <p className="subtle mono">Job {shortId(jobId)}</p>
              {job && (
                <p className="subtle">
                  Status: {job.status}
                  {job.phase ? ` · ${job.phase}` : ''}
                  {job.updatedAt ? ` · updated ${formatRelativeTime(job.updatedAt)}` : ''}
                </p>
              )}
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? 'Refreshing...' : 'Refresh trades'}
            </button>
          </div>

          {tradesData && (
            <section className="detail-panel analyzer-stats">
              <div className="analyzer-stat-grid">
                <div>
                  <span className="analyzer-stat-label">Total swaps</span>
                  <strong>{tradesData.stats.totalSwaps}</strong>
                </div>
                <div>
                  <span className="analyzer-stat-label">Buys</span>
                  <strong>{tradesData.stats.buys}</strong>
                </div>
                <div>
                  <span className="analyzer-stat-label">Sells</span>
                  <strong>{tradesData.stats.sells}</strong>
                </div>
                <div>
                  <span className="analyzer-stat-label">External buyers</span>
                  <strong>{tradesData.stats.externalBuyers}</strong>
                </div>
                <div>
                  <span className="analyzer-stat-label">External sellers</span>
                  <strong>{tradesData.stats.externalSellers}</strong>
                </div>
                <div>
                  <span className="analyzer-stat-label">Own wallet swaps</span>
                  <strong>{tradesData.stats.ownWalletSwaps}</strong>
                </div>
              </div>
              {tradesData.tradesSyncedAt && (
                <p className="subtle mono" style={{ marginTop: 12 }}>
                  Trades synced {formatRelativeTime(tradesData.tradesSyncedAt)}
                </p>
              )}
              <p className="subtle mono" style={{ marginTop: 8 }}>
                Token:{' '}
                <a href={baseScanAddress(tradesData.tokenAddress)} target="_blank" rel="noreferrer">
                  {shortId(tradesData.tokenAddress)}
                </a>
                {' · '}
                Pool:{' '}
                <a href={baseScanAddress(tradesData.poolAddress)} target="_blank" rel="noreferrer">
                  {shortId(tradesData.poolAddress)}
                </a>
              </p>
            </section>
          )}

          <section className="detail-panel">
            <div className="card-title-row">
              <h2 className="section-title">Trades</h2>
              <div className="analyzer-filters">
                <label>
                  Side
                  <select value={sideFilter} onChange={(e) => setSideFilter(e.target.value as SideFilter)}>
                    <option value="all">All</option>
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                </label>
                <label>
                  Wallet
                  <select
                    value={walletFilter}
                    onChange={(e) => setWalletFilter(e.target.value as WalletFilter)}
                  >
                    <option value="all">All</option>
                    <option value="external">External only</option>
                    <option value="own">Own wallets</option>
                  </select>
                </label>
              </div>
            </div>

            {filteredTrades.length === 0 ? (
              <p className="subtle">No trades match the current filters.</p>
            ) : (
              <div className="trade-table-wrap">
                <table className="trade-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Side</th>
                      <th>Trader</th>
                      <th>Token</th>
                      <th>ETH</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTrades.map((trade) => (
                      <TradeRow key={`${trade.txHash}:${trade.logIndex}`} trade={trade} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function TradeRow({ trade }: { trade: PoolTrade }) {
  const sideClass = trade.side === 'buy' ? 'pill success' : 'pill muted';
  return (
    <tr>
      <td className="mono">
        {trade.timestamp ? formatRelativeTime(trade.timestamp) : `#${trade.blockNumber}`}
      </td>
      <td>
        <span className={sideClass}>{trade.side}</span>
        {trade.isOwnWallet && <span className="pill muted" style={{ marginLeft: 6 }}>own</span>}
      </td>
      <td className="mono">
        <a href={baseScanAddress(trade.trader)} target="_blank" rel="noreferrer">
          {shortId(trade.trader)}
        </a>
      </td>
      <td className="mono">{trade.tokenAmountFormatted}</td>
      <td className="mono">{trade.ethAmountFormatted}</td>
      <td className="mono">
        <a href={baseScanTx(trade.txHash)} target="_blank" rel="noreferrer">
          {shortId(trade.txHash)}
        </a>
      </td>
    </tr>
  );
}
