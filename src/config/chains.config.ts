import { base, mode, mantle } from 'viem/chains';

// All supported chains
export const SUPPORTED_CHAINS = {
  base: base,
  mode: mode,
  mantle: mantle,
} as const;

export type SupportedChainType = keyof typeof SUPPORTED_CHAINS;

// Only chains supported by smartwallet (crossmint)
export const SMARTWALLET_CHAINS = {
  base: base,
  mode: mode,
} as const;

export type SupportedSmartWalletChainType = keyof typeof SMARTWALLET_CHAINS;

// Type guard to check if a chain supports smartwallet
export const isSmartWalletChain = (
  chain: SupportedChainType,
): chain is SupportedSmartWalletChainType => {
  return chain in SMARTWALLET_CHAINS;
};
