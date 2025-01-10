export interface TokenConfig {
  address: string;
  decimals: number;
  chain: string;
}

export const tokens: Record<string, TokenConfig> = {
  USDC: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    chain: 'base',
  },
  WETH: {
    address: '0x4200000000000000000000000000000000000006',
    decimals: 18,
    chain: 'base',
  },
  // Add more tokens as needed
};
