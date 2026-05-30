# Token Launch Skill (Base + Aerodrome)

Two required wallets (deploy + buy) and an optional third buy wallet on Base.

## Workflow

1. Deploy ERC20 token (default name: **AI**)
2. Create Aerodrome volatile pool and add LP with **0.01 ETH** (wallet 1)
3. Monitor pool swaps for external buyers
4. If external buyers ≥ `minBuyersBeforeRemoveLp` (default 1) → remove LP immediately (unless `removeLp: false`)
5. If no buyers after `buyAfterSeconds` (default 30) → wallet 2 buys; wallet 3 too if `useWallet3`
6. After **removeLpTimeMinutes** (default 5) → remove LP if still active (unless `removeLp: false`; use stranded LP cleanup later)

## Backend configuration

Set in `backend/.env`:

```
BASE_RPC_URL=https://mainnet.base.org
WALLET_1_PRIVATE_KEY=   # deploy + LP
WALLET_2_PRIVATE_KEY=   # buy
WALLET_3_PRIVATE_KEY=   # optional second buy wallet
```

## API

- `GET /api/tokenlaunch/status` — wallet/RPC configuration
- `GET /api/tokenlaunch` — list jobs
- `POST /api/tokenlaunch` — start launch `{ tokenName, tokenSymbol, lpEthAmount, wallet2BuyEthAmount, buyEthAmount, useWallet3?, buyAfterSeconds?, repeatCount, removeLp?, removeLpTimeMinutes?, minBuyersBeforeRemoveLp? }` (`useWallet3` default `false`, `buyAfterSeconds` default `30`, `removeLp` default `true`, `removeLpTimeMinutes` default `5`, `minBuyersBeforeRemoveLp` default `1`)
- `POST /api/tokenlaunch/:jobId/buy` — manual buy during monitoring `{ wallet: 2 | 3, ethAmount? }` (defaults to job `wallet2BuyEthAmount` or `buyEthAmount`)

## Dashboard

Open **Token Launch** in the nav for the control panel. Each launch with a pool has **View analyzer** — Aerodrome swap history (buys/sells, traders, own vs external wallets).

## Trade analyzer API

- `GET /api/tokenlaunch/:jobId/trades` — cached trades + stats (`?refresh=true` to re-fetch from chain)
- `POST /api/tokenlaunch/trades/backfill` — `{ "onlyMissing": true }` (default) backfills all launches; set `onlyMissing: false` to refresh every job

On backend startup, launches missing trades are backfilled automatically (when wallets/RPC are configured).

## Stranded LP cleanup

- `GET /api/tokenlaunch/lp/unremoved` — scan wallet 1 for Aerodrome LP still held from past launches
- `POST /api/tokenlaunch/lp/remove` — `{ "poolAddress": "0x..." }` or `{ "all": true }` (works anytime, including during monitoring)
