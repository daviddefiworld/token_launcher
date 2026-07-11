import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { deployToken, getDeployedTokens, getTokenLaunchStatus } from '../api';
import type { DeployedToken, ManualTokenDeployInput, TokenDeployType } from '../types';
import { formatRelativeTime, shortId } from '../utils';
import { LiquiditySection } from './LiquidityPage';

type ManualTab = 'deploy' | 'liquidity';

const TAB_LABELS: Record<ManualTab, string> = {
  deploy: 'Token deploy',
  liquidity: 'Liquidity'
};

const TYPE_LABELS: Record<TokenDeployType, string> = {
  normal: 'Normal token',
  tax: 'Tax token'
};

const DEFAULT_DEPLOY: ManualTokenDeployInput = {
  tokenType: 'normal',
  tokenName: 'AI',
  tokenSymbol: 'AI',
  totalSupply: '1000000000'
};

function DeployedTokenCard({
  token,
  onAddLiquidity
}: {
  token: DeployedToken;
  onAddLiquidity: (tokenAddress: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(token.tokenAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — the full address stays visible below.
    }
  };

  return (
    <article className="tl-launch-card">
      <div className="tl-launch-head">
        <div>
          <span className="tl-launch-title">
            {token.tokenName || 'Token'}{' '}
            <span className="tl-launch-sym">({token.tokenSymbol || '???'})</span>
          </span>
          <p className="tl-meta-row">
            Deployed {formatRelativeTime(token.createdAt)}
            {token.totalSupply ? ` · supply ${token.totalSupply}` : ''}
          </p>
        </div>
        <button type="button" className="button secondary" onClick={() => onAddLiquidity(token.tokenAddress)}>
          Add liquidity →
        </button>
      </div>
      <div className="tl-chips">
        <span className="tl-chip accent">{TYPE_LABELS[token.tokenType]}</span>
        <span className="tl-chip">token {shortId(token.tokenAddress)}</span>
        <span className="tl-chip">deploy tx {shortId(token.deployTxHash)}</span>
      </div>
      <p className="mono" style={{ marginTop: 10, wordBreak: 'break-all' }}>
        {token.tokenAddress}{' '}
        <button type="button" className="button secondary" style={{ marginLeft: 8 }} onClick={() => void copyAddress()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </p>
    </article>
  );
}

function TokenDeploySection({ onAddLiquidity }: { onAddLiquidity: (tokenAddress: string) => void }) {
  const [configured, setConfigured] = useState(false);
  const [wallet1Address, setWallet1Address] = useState<string>();
  const [wallet1BalanceEth, setWallet1BalanceEth] = useState<string>();
  const [statusLoading, setStatusLoading] = useState(true);

  const [input, setInput] = useState<ManualTokenDeployInput>(DEFAULT_DEPLOY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tokens, setTokens] = useState<DeployedToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(false);

  const isTax = input.tokenType === 'tax';

  const reloadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const status = await getTokenLaunchStatus();
      setConfigured(status.configured);
      setWallet1Address(status.wallet1Address);
      setWallet1BalanceEth(status.wallet1BalanceEth);
    } catch {
      setConfigured(false);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const reloadTokens = useCallback(async () => {
    setTokensLoading(true);
    try {
      setTokens(await getDeployedTokens());
    } catch {
      // List is cosmetic — a failed load leaves the previous entries in place.
    } finally {
      setTokensLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
    void reloadTokens();
  }, [reloadStatus, reloadTokens]);

  const updateInput = (field: keyof ManualTokenDeployInput, value: string) => {
    setInput((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const deployed = await deployToken(
        isTax ? { tokenType: 'tax' } : input
      );
      setNotice(
        `Deployed ${deployed.tokenName || 'token'} (${deployed.tokenSymbol || '???'}) at ${deployed.tokenAddress}`
      );
      await reloadTokens();
      void reloadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Token deploy failed');
    } finally {
      setBusy(false);
    }
  };

  const deployDisabled =
    !configured ||
    busy ||
    (!isTax && (!input.tokenName?.trim() || !input.tokenSymbol?.trim() || !input.totalSupply?.trim()));

  return (
    <>
      {!statusLoading && !configured && (
        <section className="detail-panel">
          <strong>Wallet 1 not configured.</strong>
          <p className="subtle" style={{ margin: '6px 0 0' }}>
            Set <span className="mono">WALLET_1_PRIVATE_KEY</span> in <span className="mono">backend/.env</span>, then
            restart the backend.
          </p>
        </section>
      )}

      <section className="detail-panel">
        <div className="tl-section-head">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            Deploy token
          </h2>
          <div className="tl-dex-toggle" role="group" aria-label="Token type">
            {(['normal', 'tax'] as TokenDeployType[]).map((type) => (
              <button
                key={type}
                type="button"
                className={`tl-dex-option${input.tokenType === type ? ' active' : ''}`}
                onClick={() => updateInput('tokenType', type)}
                disabled={busy}
              >
                {TYPE_LABELS[type]}
              </button>
            ))}
          </div>
        </div>

        <form className="tl-form" onSubmit={submit}>
          {isTax ? (
            <p className="subtle">
              The tax token deploys the compiled fee-on-transfer contract as-is — name, symbol, supply and taxes are
              defined inside the contract. To use your own contract, replace the compiled artifact in{' '}
              <span className="mono">backend/src/skills/tokenlaunch/compiled/</span>.
            </p>
          ) : (
            <fieldset className="tl-fieldset">
              <legend className="tl-legend">Token</legend>
              <div className="tl-grid">
                <div className="tl-field">
                  <label htmlFor="md-name">Name</label>
                  <div className="tl-input-wrap">
                    <input
                      id="md-name"
                      className="tl-input"
                      value={input.tokenName || ''}
                      onChange={(e) => updateInput('tokenName', e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="tl-field">
                  <label htmlFor="md-symbol">Symbol</label>
                  <div className="tl-input-wrap">
                    <input
                      id="md-symbol"
                      className="tl-input"
                      value={input.tokenSymbol || ''}
                      onChange={(e) => updateInput('tokenSymbol', e.target.value)}
                      required
                    />
                  </div>
                </div>
                <div className="tl-field">
                  <label htmlFor="md-supply">Total supply</label>
                  <div className="tl-input-wrap">
                    <input
                      id="md-supply"
                      className="tl-input"
                      inputMode="numeric"
                      value={input.totalSupply || ''}
                      onChange={(e) => updateInput('totalSupply', e.target.value)}
                      required
                    />
                  </div>
                </div>
              </div>
            </fieldset>
          )}

          <button type="submit" className="button tl-cta" disabled={deployDisabled}>
            {busy ? 'Deploying…' : `Deploy ${TYPE_LABELS[input.tokenType].toLowerCase()}`}
          </button>
        </form>

        {configured && wallet1Address && (
          <p className="mono">
            Wallet 1 · {wallet1Address}
            {wallet1BalanceEth ? ` · ${wallet1BalanceEth} ETH` : ''}
          </p>
        )}
        <p className="subtle">
          Deploy only — the token is minted to wallet 1 and nothing else happens. Add liquidity from the Liquidity tab
          when you are ready.
        </p>
        {notice && <p className="result">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="detail-panel">
        <div className="card-title-row">
          <h2 className="section-title">Deployed tokens</h2>
          <button
            type="button"
            className="button secondary"
            onClick={() => void reloadTokens()}
            disabled={tokensLoading}
          >
            {tokensLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {tokens.length === 0 ? (
          <div className="empty small">No tokens deployed yet — use the form above.</div>
        ) : (
          <div className="order-list">
            {tokens.map((token) => (
              <DeployedTokenCard key={token.id} token={token} onAddLiquidity={onAddLiquidity} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export function ManualLaunchPage() {
  const [tab, setTab] = useState<ManualTab>('deploy');
  const [prefillTokenAddress, setPrefillTokenAddress] = useState<string>();

  const jumpToLiquidity = (tokenAddress: string) => {
    setPrefillTokenAddress(tokenAddress);
    setTab('liquidity');
  };

  return (
    <main className="page narrow">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Robinhood · Uniswap V2</p>
          <h1>Manual Launch</h1>
          <p className="subtle">
            Run each step yourself: deploy a token (normal or tax), then manage liquidity from wallet 1.
          </p>
        </div>
        <div className="tl-dex-toggle" role="tablist" aria-label="Manual launch section">
          {(['deploy', 'liquidity'] as ManualTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`tl-dex-option${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              {TAB_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {tab === 'deploy' ? (
        <TokenDeploySection onAddLiquidity={jumpToLiquidity} />
      ) : (
        <LiquiditySection prefillTokenAddress={prefillTokenAddress} />
      )}
    </main>
  );
}
