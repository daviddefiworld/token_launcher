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
 * The `AS` fee-on-transfer token (feeToken.sol). Constructor takes NO arguments — name,
 * symbol (Asteroid Shiba / ASTEROID), 9 decimals and the total supply are hardcoded, and
 * the constructor itself creates the Uniswap V2 pair. All supply is minted to the deployer,
 * who is tax-exempt, so wallet 1 can add liquidity normally (no `enableTrading()` needed).
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
    name: '_maxWalletSize',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    // onlyOwner: raises max tx / max wallet to the full supply, i.e. removes the 2% limits
    // that otherwise revert any non-trivial buy ("Exceeds the _maxTxAmount.").
    type: 'function',
    name: 'isNotRestricted',
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
  'src_skills_tokenlaunch_LaunchToken_sol_LaunchToken.bin',
  'LaunchToken'
);

export const feeTokenBytecode = loadBytecode('feeToken_sol_AS.bin', 'feeToken (AS)');
