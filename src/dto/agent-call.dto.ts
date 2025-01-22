export type ChainType =
  | 'base'
  | 'polygon'
  | 'polygon-amoy'
  | 'base-sepolia'
  | 'arbitrum'
  | 'arbitrum-sepolia'
  | 'mode'
  | 'mode-sepolia'
  | 'optimism'
  | 'optimism-sepolia';

export class AgentCallDto {
  prompt: string;
  walletAddress: string;
  chain: ChainType;
  sessionId?: string;
}
