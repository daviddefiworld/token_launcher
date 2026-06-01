import { createWalletClient, getAddress, http, type Address, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createBasePublicClient, getBaseRpcUrl, withRpcRetry } from '../rpc';
import { BASE_CHAIN } from '../skills/tokenlaunch/config';
import type { StoredWorkflowWallet } from '../types';

const TRANSFER_GAS = 21_000n;
const MIN_SWEEP_WEI = 10_000_000_000_000n; // 0.00001 ETH

export interface SweepResult {
  walletIndex: 1 | 2 | 3;
  txHash?: Hash;
  amountEth: string;
  skipped?: boolean;
  reason?: string;
}

function normalizePrivateKey(value: string): `0x${string}` {
  const trimmed = value.trim();
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`;
}

export function resolveExchangeDepositAddress(): Address {
  const candidates = [
    process.env.EXCHANGE_DEPOSIT_ADDRESS,
    process.env.DEPOSIT_WALLET_ADDRESS,
    process.env.wallet1,
    process.env.WALLET1
  ];

  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed && /^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      return getAddress(trimmed);
    }
  }

  throw new Error(
    'Set EXCHANGE_DEPOSIT_ADDRESS (or wallet1) in backend/.env to your Bitunix Base ETH deposit address'
  );
}

function formatEth(wei: bigint): string {
  const asNumber = Number(wei) / 1e18;
  return asNumber.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export async function sweepWalletsToExchange(wallets: StoredWorkflowWallet[]): Promise<SweepResult[]> {
  const depositAddress = resolveExchangeDepositAddress();
  const publicClient = createBasePublicClient();
  const gasPrice = await withRpcRetry('gas price', () => publicClient.getGasPrice());
  const gasCost = (TRANSFER_GAS * gasPrice * 12n) / 10n;
  const results: SweepResult[] = [];

  for (const wallet of wallets) {
    const account = privateKeyToAccount(normalizePrivateKey(wallet.privateKey));
    const balance = await withRpcRetry(`balance for wallet ${wallet.index}`, () =>
      publicClient.getBalance({ address: account.address })
    );
    const value = balance - gasCost;

    if (value <= MIN_SWEEP_WEI) {
      results.push({
        walletIndex: wallet.index,
        amountEth: '0',
        skipped: true,
        reason: 'balance too low after gas'
      });
      continue;
    }

    const walletClient = createWalletClient({
      chain: BASE_CHAIN,
      transport: http(getBaseRpcUrl()),
      account
    });
    const hash = await walletClient.sendTransaction({
      account,
      to: depositAddress,
      value,
      gas: TRANSFER_GAS
    });
    await publicClient.waitForTransactionReceipt({ hash });
    results.push({ walletIndex: wallet.index, txHash: hash, amountEth: formatEth(value) });
  }

  return results;
}
