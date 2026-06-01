import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  cancelLaunchWorkflow,
  depositLaunchWorkflow,
  getLaunchWorkflows,
  startLaunchWorkflow,
  type LaunchWorkflowInput,
  type TokenLaunchInput
} from '../api';
import type { ExtensionRecord, LaunchWorkflow, LaunchWorkflowStatus } from '../types';
import { canDepositWorkflow, formatRelativeTime, shortId } from '../utils';

const DEFAULT_TOKEN_LAUNCH: TokenLaunchInput = {
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
  minBuyersBeforeRemoveLp: 2
};

const ACTIVE_STATUSES: LaunchWorkflowStatus[] = [
  'pending',
  'creating_wallets',
  'withdrawing',
  'waiting_funds',
  'launching',
  'analyzing',
  'depositing'
];

function statusClass(status: LaunchWorkflowStatus): string {
  if (status === 'completed') return 'pill success';
  if (status === 'failed' || status === 'cancelled') return 'pill danger';
  return 'pill muted';
}

function baseScanAddress(address: string): string {
  return `https://basescan.org/address/${address}`;
}

export function WorkflowPage({
  extensions,
  workflows: initialWorkflows,
  reloadWorkflows
}: {
  extensions: ExtensionRecord[];
  workflows: LaunchWorkflow[];
  reloadWorkflows: () => Promise<void>;
}) {
  const [workflows, setWorkflows] = useState<LaunchWorkflow[]>(initialWorkflows);
  const [extensionId, setExtensionId] = useState('');
  const [walletCount, setWalletCount] = useState<2 | 3>(2);
  const [autoStartLaunch, setAutoStartLaunch] = useState(true);
  const [analyzeOnComplete, setAnalyzeOnComplete] = useState(true);
  const [tokenLaunch, setTokenLaunch] = useState<TokenLaunchInput>(DEFAULT_TOKEN_LAUNCH);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [depositBusy, setDepositBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setWorkflows(initialWorkflows);
  }, [initialWorkflows]);

  useEffect(() => {
    if (extensionId || extensions.length === 0) return;
    setExtensionId(extensions[0].extensionId);
  }, [extensionId, extensions]);

  const hasActiveWorkflow = workflows.some((workflow) => ACTIVE_STATUSES.includes(workflow.status));

  useEffect(() => {
    if (!hasActiveWorkflow) return;
    const timer = window.setInterval(() => {
      void reloadWorkflows();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [hasActiveWorkflow, reloadWorkflows]);

  const updateTokenLaunch = (field: keyof TokenLaunchInput, value: string | number | boolean) => {
    setTokenLaunch((current) => ({ ...current, [field]: value }));
  };

  const refreshWorkflows = useCallback(async () => {
    setWorkflows(await getLaunchWorkflows());
  }, []);

  const startWorkflow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!extensionId) {
      setError('Select a connected extension');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const input: LaunchWorkflowInput = {
        extensionId,
        walletCount,
        autoStartLaunch,
        analyzeOnComplete,
        tokenLaunch: {
          ...tokenLaunch,
          useWallet3: walletCount === 3,
          repeatCount: 1
        }
      };
      const workflow = await startLaunchWorkflow(input);
      await reloadWorkflows();
      setNotice(`Workflow started for "${tokenLaunch.tokenName}".`);
      setWorkflows((current) => [workflow, ...current.filter((item) => item.workflowId !== workflow.workflowId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setBusy(false);
    }
  };

  const cancelWorkflow = async (workflow: LaunchWorkflow) => {
    setCancelBusy(workflow.workflowId);
    setError(null);
    try {
      await cancelLaunchWorkflow(workflow.workflowId);
      await reloadWorkflows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel workflow');
    } finally {
      setCancelBusy(null);
    }
  };

  const depositWorkflow = async (workflow: LaunchWorkflow) => {
    setDepositBusy(workflow.workflowId);
    setError(null);
    setNotice(null);
    try {
      await depositLaunchWorkflow(workflow.workflowId);
      await reloadWorkflows();
      setNotice(`Deposit sweep started for "${workflow.input.tokenLaunch.tokenName}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deposit workflow funds');
    } finally {
      setDepositBusy(null);
    }
  };

  return (
    <main className="page narrow">
      <div className="page-heading">
        <div>
          <p className="eyebrow">End-to-end automation</p>
          <h1>Launch Workflow</h1>
          <p className="subtle">
            One process: generate fresh wallets, fund them via Bitunix withdraw, optionally auto-launch the token, then
            sync analyzer trades when finished.
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => void refreshWorkflows()}>
          Refresh
        </button>
      </div>

      <section className="detail-panel">
        <h2 className="section-title">Start workflow</h2>
        {extensions.length === 0 ? (
          <p className="error">No extension connected. Open the browser extension side panel first.</p>
        ) : (
          <form className="withdraw-form" onSubmit={startWorkflow}>
            <label>
              Extension
              <select value={extensionId} onChange={(e) => setExtensionId(e.target.value)} required>
                {extensions.map((extension) => (
                  <option key={extension.extensionId} value={extension.extensionId}>
                    {shortId(extension.extensionId)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Wallet count
              <select
                value={walletCount}
                onChange={(e) => setWalletCount(e.target.value === '3' ? 3 : 2)}
                disabled={busy || hasActiveWorkflow}
              >
                <option value={2}>2 (deploy + buy)</option>
                <option value={3}>3 (deploy + 2 buy wallets)</option>
              </select>
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoStartLaunch}
                onChange={(e) => setAutoStartLaunch(e.target.checked)}
                disabled={busy || hasActiveWorkflow}
              />
              Auto-start token launch after funding
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={analyzeOnComplete}
                onChange={(e) => setAnalyzeOnComplete(e.target.checked)}
                disabled={busy || hasActiveWorkflow || !autoStartLaunch}
              />
              Analyze trades when launch finishes
            </label>
            <label>
              Token name
              <input
                value={tokenLaunch.tokenName}
                onChange={(e) => updateTokenLaunch('tokenName', e.target.value)}
                required
              />
            </label>
            <label>
              Token symbol
              <input
                value={tokenLaunch.tokenSymbol}
                onChange={(e) => updateTokenLaunch('tokenSymbol', e.target.value)}
                required
              />
            </label>
            <label>
              LP ETH amount
              <input
                value={tokenLaunch.lpEthAmount}
                onChange={(e) => updateTokenLaunch('lpEthAmount', e.target.value)}
                required
              />
            </label>
            <label>
              Wallet 2 buy amount (ETH)
              <input
                value={tokenLaunch.wallet2BuyEthAmount}
                onChange={(e) => updateTokenLaunch('wallet2BuyEthAmount', e.target.value)}
                required
              />
            </label>
            {walletCount === 3 && (
              <label>
                Wallet 3 buy amount (ETH)
                <input
                  value={tokenLaunch.buyEthAmount}
                  onChange={(e) => updateTokenLaunch('buyEthAmount', e.target.value)}
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
                value={tokenLaunch.buyAfterSeconds}
                onChange={(e) =>
                  updateTokenLaunch('buyAfterSeconds', Math.max(1, Number.parseInt(e.target.value, 10) || 30))
                }
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
                value={tokenLaunch.removeLpTimeMinutes}
                onChange={(e) =>
                  updateTokenLaunch('removeLpTimeMinutes', Math.max(1, Number.parseInt(e.target.value, 10) || 5))
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
                value={tokenLaunch.minBuyersBeforeRemoveLp}
                onChange={(e) =>
                  updateTokenLaunch(
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
                checked={tokenLaunch.removeLp}
                onChange={(e) => updateTokenLaunch('removeLp', e.target.checked)}
              />
              Remove LP automatically
            </label>
            <button type="submit" className="button" disabled={busy || hasActiveWorkflow || !extensionId}>
              {busy ? 'Starting...' : hasActiveWorkflow ? 'Workflow running...' : 'Start full workflow'}
            </button>
          </form>
        )}
        {hasActiveWorkflow && !busy && (
          <p className="subtle">A workflow is in progress. Wait for it to finish before starting another.</p>
        )}
        {notice && <p className="result">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section>
        <h2 className="section-title">Recent workflows</h2>
        {workflows.length === 0 ? (
          <div className="empty small">No workflows yet.</div>
        ) : (
          <div className="order-list">
            {workflows.map((workflow) => (
              <article key={workflow.workflowId} className="order-card">
                <div className="card-title-row">
                  <strong>{workflow.input.tokenLaunch.tokenName}</strong>
                  <span className={statusClass(workflow.status)}>{workflow.status}</span>
                </div>
                <p className="subtle order-summary">
                  {workflow.input.walletCount} wallets
                  {workflow.input.autoStartLaunch ? ' · auto launch' : ' · fund only'}
                  {workflow.phase ? ` · ${workflow.phase}` : ''}
                </p>
                <p className="subtle mono">
                  Workflow {shortId(workflow.workflowId)} · {formatRelativeTime(workflow.updatedAt)}
                </p>
                {workflow.wallets && workflow.wallets.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {workflow.wallets.map((wallet) => (
                      <p key={wallet.index} className="subtle mono">
                        Wallet {wallet.index}:{' '}
                        <a href={baseScanAddress(wallet.address)} target="_blank" rel="noreferrer">
                          {shortId(wallet.address)}
                        </a>
                      </p>
                    ))}
                  </div>
                )}
                {workflow.analysis && (
                  <p className="subtle" style={{ marginTop: 8 }}>
                    Analysis: {workflow.analysis.stats.totalSwaps} swaps · {workflow.analysis.stats.externalBuyers}{' '}
                    external buyers
                  </p>
                )}
                {workflow.depositTxHashes && workflow.depositTxHashes.length > 0 && (
                  <p className="subtle mono" style={{ marginTop: 8 }}>
                    Deposited to exchange: {workflow.depositTxHashes.length} tx
                    {workflow.depositTxHashes.map((hash) => (
                      <span key={hash}>
                        {' '}
                        ·{' '}
                        <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">
                          {shortId(hash)}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                {workflow.launchJobId && (
                  <p style={{ marginTop: 10 }}>
                    <Link to={`/tokenlaunch/${workflow.launchJobId}`} className="back-link" style={{ marginBottom: 0 }}>
                      View launch analyzer
                    </Link>
                  </p>
                )}
                {(ACTIVE_STATUSES.includes(workflow.status) || canDepositWorkflow(workflow)) && (
                  <div className="button-row" style={{ marginTop: 12 }}>
                    {canDepositWorkflow(workflow) && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={
                          depositBusy === workflow.workflowId ||
                          cancelBusy === workflow.workflowId ||
                          Boolean(depositBusy)
                        }
                        onClick={() => void depositWorkflow(workflow)}
                      >
                        {depositBusy === workflow.workflowId ? 'Depositing...' : 'Deposit to exchange'}
                      </button>
                    )}
                    {ACTIVE_STATUSES.includes(workflow.status) && (
                      <button
                        type="button"
                        className="button secondary danger-outline"
                        disabled={cancelBusy === workflow.workflowId || depositBusy === workflow.workflowId}
                        onClick={() => void cancelWorkflow(workflow)}
                      >
                        {cancelBusy === workflow.workflowId ? 'Cancelling...' : 'Cancel workflow'}
                      </button>
                    )}
                  </div>
                )}
                {workflow.error && <p className="error">{workflow.error}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
