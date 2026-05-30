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

const BYTECODE_FILE = 'src_skills_tokenlaunch_LaunchToken_sol_LaunchToken.bin';

function bytecodeCandidates(): string[] {
  return [
    join(__dirname, 'compiled', BYTECODE_FILE),
    join(process.cwd(), 'src/skills/tokenlaunch/compiled', BYTECODE_FILE),
    join(process.cwd(), 'dist/skills/tokenlaunch/compiled', BYTECODE_FILE)
  ];
}

function loadLaunchTokenBytecode(): `0x${string}` {
  for (const path of bytecodeCandidates()) {
    if (!existsSync(path)) continue;
    const hex = readFileSync(path, 'utf8').trim();
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(`Invalid LaunchToken bytecode file: ${path}`);
    }
    return `0x${hex}` as `0x${string}`;
  }

  throw new Error(
    'LaunchToken bytecode not found. Compile LaunchToken.sol and place the .bin file in src/skills/tokenlaunch/compiled/.'
  );
}

export const launchTokenBytecode = loadLaunchTokenBytecode();
