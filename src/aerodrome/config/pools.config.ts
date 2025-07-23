export interface PoolConfig {
  name: string;
  address: string;
  token0: string;
  token1: string;
  token0Name: string; // Token name for Pyth API
  token1Name: string; // Token name for Pyth API
  token0Decimals: number;
  token1Decimals: number;
  fee?: number; // Fee in pips (parts per million), e.g., 500 for 0.05%
  tickSpacing: number; // Tick spacing for the pool
  description?: string;
  subgraphUrl?: string; // Subgraph URL for this pool
}

export const AERODROME_POOLS: Record<string, PoolConfig> = {
  'usdc-usd+': {
    name: 'USDC-USD+',
    address: '0x...', // TODO: Add actual Aerodrome pool contract address
    token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    token1: '0x...', // TODO: Add USD+ token address
    token0Name: 'usdc',
    token1Name: 'usd+', // TODO: Update with correct token name for Pyth
    token0Decimals: 6,
    token1Decimals: 18,
    fee: 100, // 100 pips (0.01%) fee
    tickSpacing: 1, // Stable pools have tick spacing of 1
    description: 'USDC to USD+ stablecoin pool',
  },
  'weth-usdc': {
    name: 'WETH-USDC',
    address: '0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59', // TODO: Add actual Aerodrome pool contract address
    token0: '0x4200000000000000000000000000000000000006', // WETH on Base
    token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    token0Name: 'eth', // WETH maps to ETH for Pyth API
    token1Name: 'usdc',
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 436, // 436 pips (0.0436%) fee
    tickSpacing: 100, // WETH-USDC pool has tick spacing of 100
    description: 'Wrapped Ethereum to USDC liquidity pool',
    subgraphUrl:
      'https://gateway.thegraph.com/api/subgraphs/id/7zcFovqfFuJQU5ygitcnKjpU95YCEuXyKCBSnZrtSu4J',
  },
  // Add more pools as needed
};

export function getPoolConfig(poolName: string): PoolConfig | null {
  return AERODROME_POOLS[poolName.toLowerCase()] || null;
}

export function getAllPools(): PoolConfig[] {
  return Object.values(AERODROME_POOLS);
}

export function isValidPool(poolName: string): boolean {
  return poolName.toLowerCase() in AERODROME_POOLS;
}
