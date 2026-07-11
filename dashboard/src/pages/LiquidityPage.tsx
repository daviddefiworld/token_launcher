import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  addLiquidity,
  getLpPositions,
  getTokenLaunchStatus,
  lookupLpPosition,
  removeLiquidity
} from '../api';
import type { AddLiquidityInput, DexKey, LpPosition } from '../types';
import { shortId } from '../utils';

const DEX_LABELS: Record<DexKey, string> = {
  aerodrome: 'Aerodrome',
  uniswap: 'Uniswap V2'
};

const EMPTY_ADD: AddLiquidityInput = { tokenAddress: '', tokenAmount: '', ethAmount: '' };

function trimAmount(value: string | undefined): string {
  if (!value) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(2);
  return String(Number(n.toFixed(6)));
}

function PositionCard({
  position,
  busy,
  onRemove
}: {
  position: LpPosition;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <article className="tl-launch-card">
      <div className="tl-launch-head">
        <div>
          <span className="tl-launch-title">
            {position.tokenSymbol || 'Token'}{' '}
            <span className="tl-launch-sym">({shortId(position.tokenAddress)})</span>
          </span>
          <p className="tl-meta-row">
            {trimAmount(position.pooledToken)} {position.tokenSymbol || 'tokens'} +{' '}
            {trimAmount(position.pooledEth)} ETH pooled
          </p>
        </div>
        <button type="button" className="button secondary danger-outline" disabled={busy} onClick={onRemove}>
          {busy ? 'Removing…' : 'Remove LP'}
        </button>
      </div>
      <div className="tl-chips">
        <span className="tl-chip accent">{DEX_LABELS[position.dex]}</span>
        <span className="tl-chip">LP {position.lpBalance}</span>
        <span className="tl-chip">pool {shortId(position.poolAddress)}</span>
      </div>
    </article>
  );
}

/**
 * Add/remove liquidity panels, embeddable inside the Manual Launch page.
 * `prefillTokenAddress` fills the add-liquidity token field (e.g. straight after a deploy).
 */
export function LiquiditySection({ prefillTokenAddress }: { prefillTokenAddress?: string }) {
  const [configured, setConfigured] = useState(false);
  const [wallet1Address, setWallet1Address] = useState<string>();
  const [statusLoading, setStatusLoading] = useState(true);

  const [positions, setPositions] = useState<LpPosition[]>([]);
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);

  const [addInput, setAddInput] = useState<AddLiquidityInput>(EMPTY_ADD);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addNotice, setAddNotice] = useState<string | null>(null);

  const [removeAddress, setRemoveAddress] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupResult, setLookupResult] = useState<LpPosition | null>(null);
  const [removeBusyPool, setRemoveBusyPool] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);

  const reloadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const status = await getTokenLaunchStatus();
      setConfigured(status.configured);
      setWallet1Address(status.wallet1Address);
    } catch {
      setConfigured(false);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const reloadPositions = useCallback(async () => {
    if (!configured) return;
    setPositionsLoading(true);
    setPositionsError(null);
    try {
      setPositions(await getLpPositions());
    } catch (err) {
      setPositionsError(err instanceof Error ? err.message : 'Failed to load LP positions');
    } finally {
      setPositionsLoading(false);
    }
  }, [configured]);

  useEffect(() => {
    void reloadStatus();
  }, [reloadStatus]);

  useEffect(() => {
    void reloadPositions();
  }, [reloadPositions]);

  useEffect(() => {
    if (prefillTokenAddress) {
      setAddInput((current) => ({ ...current, tokenAddress: prefillTokenAddress }));
    }
  }, [prefillTokenAddress]);

  const updateAddInput = (field: keyof AddLiquidityInput, value: string) => {
    setAddInput((current) => ({ ...current, [field]: value }));
  };

  const submitAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAddBusy(true);
    setAddError(null);
    setAddNotice(null);
    try {
      const result = await addLiquidity(addInput);
      const { position } = result;
      setAddNotice(
        `Added ${trimAmount(position.pooledToken)} ${position.tokenSymbol || 'tokens'} + ` +
          `${trimAmount(position.pooledEth)} ETH · pool ${shortId(position.poolAddress)} · tx ${shortId(result.addTxHash)}`
      );
      setAddInput(EMPTY_ADD);
      await reloadPositions();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add liquidity');
    } finally {
      setAddBusy(false);
    }
  };

  const lookup = async () => {
    setLookupBusy(true);
    setRemoveError(null);
    setRemoveNotice(null);
    setLookupResult(null);
    try {
      const found = await lookupLpPosition(removeAddress.trim());
      if (!found) {
        setRemoveError(`Wallet 1 holds no LP for ${removeAddress.trim()}`);
        return;
      }
      setLookupResult(found);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setLookupBusy(false);
    }
  };

  const remove = async (target: { poolAddress: string } | { tokenAddress: string }, poolKey: string) => {
    setRemoveBusyPool(poolKey);
    setRemoveError(null);
    setRemoveNotice(null);
    try {
      const result = await removeLiquidity(target);
      setRemoveNotice(`Removed LP from pool ${shortId(result.poolAddress)} · tx ${shortId(result.txHash || '')}`);
      setLookupResult(null);
      setRemoveAddress('');
      await reloadPositions();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove liquidity');
    } finally {
      setRemoveBusyPool(null);
    }
  };

  const addDisabled =
    !configured ||
    addBusy ||
    !addInput.tokenAddress.trim() ||
    !addInput.tokenAmount.trim() ||
    !addInput.ethAmount.trim();

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
        <h2 className="section-title">Add liquidity</h2>
        <form className="tl-form" onSubmit={submitAdd}>
          <fieldset className="tl-fieldset">
            <div className="tl-field">
              <label htmlFor="lq-token">Token address</label>
              <div className="tl-input-wrap">
                <input
                  id="lq-token"
                  className="tl-input mono"
                  placeholder="0x…"
                  value={addInput.tokenAddress}
                  onChange={(e) => updateAddInput('tokenAddress', e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="tl-grid">
              <div className="tl-field">
                <label htmlFor="lq-token-amount">Token amount</label>
                <div className="tl-input-wrap">
                  <input
                    id="lq-token-amount"
                    className="tl-input"
                    inputMode="decimal"
                    placeholder="1000000"
                    value={addInput.tokenAmount}
                    onChange={(e) => updateAddInput('tokenAmount', e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="tl-field">
                <label htmlFor="lq-eth-amount">ETH amount</label>
                <div className="tl-input-wrap">
                  <input
                    id="lq-eth-amount"
                    className="tl-input"
                    inputMode="decimal"
                    placeholder="0.01"
                    value={addInput.ethAmount}
                    onChange={(e) => updateAddInput('ethAmount', e.target.value)}
                    required
                  />
                  <span className="tl-unit">ETH</span>
                </div>
              </div>
            </div>
          </fieldset>

          <button type="submit" className="button tl-cta" disabled={addDisabled}>
            {addBusy ? 'Adding liquidity…' : 'Add liquidity'}
          </button>
        </form>
        {wallet1Address && (
          <p className="mono">
            Wallet 1 · {wallet1Address}
          </p>
        )}
        {addNotice && <p className="result">{addNotice}</p>}
        {addError && <p className="error">{addError}</p>}
      </section>

      <section className="detail-panel">
        <div className="card-title-row">
          <h2 className="section-title">Remove liquidity</h2>
          <button
            type="button"
            className="button secondary"
            onClick={() => void reloadPositions()}
            disabled={!configured || positionsLoading || Boolean(removeBusyPool)}
          >
            {positionsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        <p className="subtle">Saved LP positions held by wallet 1.</p>
        {positionsLoading ? (
          <p className="subtle">Reading on-chain LP balances…</p>
        ) : positions.length === 0 ? (
          <div className="empty small">No saved LP positions. Add liquidity above, or remove by token address.</div>
        ) : (
          <div className="order-list">
            {positions.map((position) => (
              <PositionCard
                key={position.poolAddress}
                position={position}
                busy={removeBusyPool === position.poolAddress}
                onRemove={() => void remove({ poolAddress: position.poolAddress }, position.poolAddress)}
              />
            ))}
          </div>
        )}
        {positionsError && <p className="error">{positionsError}</p>}

        <fieldset className="tl-fieldset" style={{ marginTop: 18 }}>
          <legend className="tl-legend">Remove by token address</legend>
          <div className="tl-field">
            <div className="tl-input-wrap">
              <input
                className="tl-input mono"
                placeholder="0x…"
                value={removeAddress}
                onChange={(e) => {
                  setRemoveAddress(e.target.value);
                  setLookupResult(null);
                }}
              />
            </div>
          </div>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button secondary"
              disabled={!configured || lookupBusy || !removeAddress.trim() || Boolean(removeBusyPool)}
              onClick={() => void lookup()}
            >
              {lookupBusy ? 'Checking…' : 'Check LP'}
            </button>
            <button
              type="button"
              className="button"
              disabled={!configured || !removeAddress.trim() || Boolean(removeBusyPool)}
              onClick={() => void remove({ tokenAddress: removeAddress.trim() }, removeAddress.trim())}
            >
              {removeBusyPool === removeAddress.trim() ? 'Removing…' : 'Remove LP'}
            </button>
          </div>
          {lookupResult && (
            <p className="result">
              {DEX_LABELS[lookupResult.dex]} pool {shortId(lookupResult.poolAddress)} ·{' '}
              {trimAmount(lookupResult.pooledToken)} {lookupResult.tokenSymbol || 'tokens'} +{' '}
              {trimAmount(lookupResult.pooledEth)} ETH
            </p>
          )}
        </fieldset>

        {removeNotice && <p className="result">{removeNotice}</p>}
        {removeError && <p className="error">{removeError}</p>}
      </section>
    </>
  );
}
