import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const launchTokenAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_name', type: 'string' },
      { name: '_symbol', type: 'string' },
      { name: '_supply', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const;

/**
 * The fee-on-transfer token (tokens/Mystery.sol — "Mystery" / MYSTERY, 18 decimals, 1B supply,
 * 2% buy + 2% sell tax). Constructor takes NO arguments and itself creates the Uniswap V2 pair.
 * All supply is minted to the deployer, who is both tax- and limit-exempt, so wallet 1 can add
 * liquidity normally.
 *
 * IMPORTANT — the token launches LOCKED. `limitsEnabled` is true and `tradingEnabled` is false,
 * and `_transfer` reverts with "_transfer:: Trading is not active." for any transfer between two
 * non-exempt, non-owner addresses. That covers the pair->router leg of an LP removal and every
 * external buy, which the router masks as "UniswapV2: TRANSFER_FAILED".
 *
 * `openTrading()` cannot unlock it: it requires `msg.sender == addop`, and `addop` is never set
 * (zero address). The only usable unlock is the owner-only `removeLimitsNow()`, which sets
 * `limitsEnabled = false` — that skips the whole limits block in `_transfer`, including the
 * trading-active require and the max-wallet/max-tx caps. Hence `removeLimitsNow()` is what gates
 * both buying and LP removal, and it must be called after adding liquidity.
 */
export const feeTokenAbi = [
  { type: 'constructor', inputs: [] },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'owner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    // `_limitsEnabled` is the master switch: while true, non-exempt transfers are blocked
    // (trading not active) and capped by maxWallet/maxTx.
    type: 'function',
    name: 'readLimitsInfo',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '_limitsEnabled', type: 'bool' },
      { name: '_maxWallet', type: 'uint256' },
      { name: '_maxTx', type: 'uint256' }
    ]
  },
  {
    // onlyOwner: sets limitsEnabled = false, which unblocks buys AND the pair->router burn
    // transfer during LP removal. This is the token's only working unlock (see note above).
    type: 'function',
    name: 'removeLimitsNow',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  }
] as const;

function bytecodeCandidates(fileName: string): string[] {
  return [
    join(__dirname, 'compiled', fileName),
    join(process.cwd(), 'src/skills/tokenlaunch/compiled', fileName),
    join(process.cwd(), 'dist/skills/tokenlaunch/compiled', fileName)
  ];
}

function loadBytecode(fileName: string, label: string): `0x${string}` {
  for (const path of bytecodeCandidates(fileName)) {
    if (!existsSync(path)) continue;
    const hex = readFileSync(path, 'utf8').trim();
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`Invalid ${label} bytecode file: ${path}`);
    }
    return `0x${hex}` as `0x${string}`;
  }

  throw new Error(
    `${label} bytecode not found. Compile the contract and place the .bin file in src/skills/tokenlaunch/compiled/.`
  );
}

export const launchTokenBytecode = loadBytecode(
  'LaunchToken_sol_LaunchToken.bin',
  'LaunchToken'
);

export const feeTokenBytecode = loadBytecode('Mystery_sol_Mystery.bin', 'feeToken (Mystery)');
