import { defineChain, parseEther } from 'viem';

/**
 * Robinhood mainnet (chainId 4663 / 0x1237). Native gas token is ETH; the canonical
 * wrapped-native is the WETH below (returned by the Uniswap V2 router's WETH()).
 * `BASE_CHAIN` keeps its historical name — it is simply "the chain this tool operates
 * on" — so the ~dozen `chain: BASE_CHAIN` call sites don't need touching.
 */
export const BASE_CHAIN = defineChain({
  id: 4663,
  name: 'Robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.mainnet.chain.robinhood.com'] }
  }
});

/**
 * Minimum ETH value for an external buy to count toward buyer DETECTION (the metric
 * that triggers LP removal / "no buyers → own wallets buy"). Buys below this are still
 * recorded, shown on the analyzer, and counted in the seen swap totals — just ignored
 * for detection so dust/spam buys can't trigger the automation.
 */
export const MIN_DETECTION_BUY_ETH = '0.0001';
export const MIN_DETECTION_BUY_WEI = parseEther(MIN_DETECTION_BUY_ETH);

export const AERODROME = {
  router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43' as const,
  factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' as const,
  weth: '0x4200000000000000000000000000000000000006' as const
};

/**
 * Uniswap V2 on Robinhood mainnet (chainId 4663). Router is user-supplied; factory and
 * WETH were read on-chain from the router (factory() / WETH()) and the WETH token was
 * confirmed to report symbol "WETH" with 18 decimals.
 */
export const UNISWAP = {
  router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba' as const,
  factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f' as const,
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as const
};

/** WETH9 — unwrap claimed LP fees to native ETH */
export const wethAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: []
  }
] as const;

export const DEFAULT_TOKEN_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const DEFAULT_LP_ETH = '0.01';
export const DEFAULT_BUY_ETH = '0.001';
export const DEFAULT_REMOVE_LP_TIME_MINUTES = 5;
export const MAX_REMOVE_LP_TIME_MINUTES = 180;
export const DEFAULT_MIN_BUYERS_BEFORE_REMOVE_LP = 1;
export const MAX_MIN_BUYERS_BEFORE_REMOVE_LP = 100;
export const MONITOR_DURATION_MS = DEFAULT_REMOVE_LP_TIME_MINUTES * 60 * 1000;
export const DEFAULT_BUY_AFTER_SECONDS = 30;
export const MAX_BUY_AFTER_SECONDS = 3600;
export const NO_BUYER_CHECK_MS = DEFAULT_BUY_AFTER_SECONDS * 1000;
export const SWAP_POLL_MS = 5_000;

export const aerodromeRouterAbi = [
  {
    type: 'function',
    name: 'addLiquidityETH',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'stable', type: 'bool' },
      { name: 'amountTokenDesired', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'removeLiquidityETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'stable', type: 'bool' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' }
    ]
  },
  {
    // Fee-on-transfer-safe LP removal (Solidly/Aerodrome variant, keeps the `stable` flag).
    type: 'function',
    name: 'removeLiquidityETHSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'stable', type: 'bool' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amountETH', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' }
        ]
      },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }]
  }
] as const;

export const aerodromeFactoryAbi = [
  {
    type: 'event',
    name: 'PoolCreated',
    inputs: [
      { name: 'token0', type: 'address', indexed: true },
      { name: 'token1', type: 'address', indexed: true },
      { name: 'stable', type: 'bool', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
      { name: 'index', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'stable', type: 'bool' }
    ],
    outputs: [{ name: 'pool', type: 'address' }]
  },
  {
    type: 'function',
    name: 'createPool',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'stable', type: 'bool' }
    ],
    outputs: [{ name: 'pool', type: 'address' }]
  }
] as const;

export const aerodromePoolAbi = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount0In', type: 'uint256', indexed: false },
      { name: 'amount1In', type: 'uint256', indexed: false },
      { name: 'amount0Out', type: 'uint256', indexed: false },
      { name: 'amount1Out', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
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
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'claimFees',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [
      { name: 'claimed0', type: 'uint256' },
      { name: 'claimed1', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'claimable0',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'claimable1',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
] as const;

/**
 * Uniswap V2 Router02. Same function names as Aerodrome but no `stable` flag and a
 * flat `address[] path` instead of the Solidly `Route[]` tuple.
 */
export const uniswapRouterAbi = [
  {
    type: 'function',
    name: 'addLiquidityETH',
    stateMutability: 'payable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'amountTokenDesired', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' },
      { name: 'liquidity', type: 'uint256' }
    ]
  },
  {
    type: 'function',
    name: 'removeLiquidityETH',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [
      { name: 'amountToken', type: 'uint256' },
      { name: 'amountETH', type: 'uint256' }
    ]
  },
  {
    // Fee-on-transfer-safe LP removal: forwards the router's actual received token balance
    // instead of the exact computed amount, so a taxed token doesn't revert on the burn.
    type: 'function',
    name: 'removeLiquidityETHSupportingFeeOnTransferTokens',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'liquidity', type: 'uint256' },
      { name: 'amountTokenMin', type: 'uint256' },
      { name: 'amountETHMin', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amountETH', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'swapExactETHForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }]
  },
  {
    // Fee-on-transfer-safe buy: validates the recipient's received balance delta against
    // amountOutMin instead of asserting the exact router-computed amount, so a taxed token
    // (like the AS fee token) doesn't revert. Same call signature as swapExactETHForTokens.
    type: 'function',
    name: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: []
  }
] as const;

export const uniswapFactoryAbi = [
  {
    type: 'event',
    name: 'PairCreated',
    inputs: [
      { name: 'token0', type: 'address', indexed: true },
      { name: 'token1', type: 'address', indexed: true },
      { name: 'pair', type: 'address', indexed: false },
      { name: 'allPairsLength', type: 'uint256', indexed: false }
    ]
  },
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' }
    ],
    outputs: [{ name: 'pair', type: 'address' }]
  }
] as const;

/**
 * Uniswap V2 pair. Note the `Swap` event arg order differs from Aerodrome
 * (`to` is the last, second indexed param). Pairs have no claimFees/claimable accessors.
 */
export const uniswapPoolAbi = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount0In', type: 'uint256', indexed: false },
      { name: 'amount1In', type: 'uint256', indexed: false },
      { name: 'amount0Out', type: 'uint256', indexed: false },
      { name: 'amount1Out', type: 'uint256', indexed: false },
      { name: 'to', type: 'address', indexed: true }
    ]
  },
  {
    type: 'function',
    name: 'token0',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'token1',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
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
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const;
