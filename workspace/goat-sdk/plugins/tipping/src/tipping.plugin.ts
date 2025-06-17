import { type Chain, PluginBase } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { TippingService } from './tipping.service';
import { Model } from 'mongoose';
import { User } from '@/schemas/user.schema';
import { PendingTip } from '@/schemas/pending-tip.schema';
import { ethers } from 'ethers';

const SUPPORTED_CHAINS = [
  '42161', // arbitrum
  '8453', // base
];

export class TippingPlugin extends PluginBase<EVMWalletClient> {
  constructor(
    private readonly userModel: Model<User>,
    private readonly pendingTipModel: Model<PendingTip>,
    private readonly rpcUrl: string,
    private readonly signerPrivateKey: string,
  ) {
    super('tipping', [
      new TippingService(userModel, pendingTipModel, rpcUrl, signerPrivateKey),
    ]);
  }

  supportsChain = (chain: Chain) =>
    chain.type === 'evm' && SUPPORTED_CHAINS.includes(chain.id.toString());
}

export const tipping = (
  userModel: Model<User>,
  pendingTipModel: Model<PendingTip>,
  rpcUrl: string,
  signerPrivateKey: string,
) => new TippingPlugin(userModel, pendingTipModel, rpcUrl, signerPrivateKey);
