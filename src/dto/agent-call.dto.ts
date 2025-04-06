import {
  SupportedChainType,
  SupportedSmartWalletChainType,
} from '../config/chains.config';

export type ChainType = SupportedChainType;
export type SmartWalletChainType = SupportedSmartWalletChainType;

export class AgentCallDto {
  prompt: string;
  walletAddress: string;
  chain: SmartWalletChainType;
  sessionId?: string;
}

export class AgentCallViemDto {
  prompt: string;
  walletAddress: string;
  chain: ChainType;
  privateKey: string;
  sessionId?: string;
}
