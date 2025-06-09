import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi } from 'viem';
import { SendTipParameters, ClaimPendingTipsParameters } from './parameters';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '@/schemas/user.schema';
import { PendingTip } from '@/schemas/pending-tip.schema';
import { ethers } from 'ethers';

export class TippingService {
  private wallet: ethers.Wallet;
  private safeWalletAddress: string;

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(PendingTip.name) private pendingTipModel: Model<PendingTip>,
    rpcUrl: string,
    signerPrivateKey: string,
  ) {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(signerPrivateKey, provider);
    this.safeWalletAddress = this.wallet.address;
  }

  @Tool({
    name: 'send_tip',
    description:
      'Send a tip to another user on X. Call this tool if the user has mentioned "tip" in their tweet.',
  })
  async sendTip(walletClient: EVMWalletClient, parameters: SendTipParameters) {
    try {
      console.log('=== Starting sendTip operation ===');
      console.log('Parameters:', {
        recipient: parameters.recipient,
        tokenAddress: parameters.tokenAddress,
        amount: parameters.amount,
      });

      // Normalize the X handle (remove @ if present)
      const normalizedHandle = parameters.recipient.startsWith('@')
        ? parameters.recipient.slice(1)
        : parameters.recipient;
      console.log('Normalized handle:', normalizedHandle);

      // Check if recipient has an account and get their wallet address
      console.log('Checking recipient info...');
      const { hasAccount, walletAddress } =
        await this.getRecipientInfo(normalizedHandle);
      console.log('Recipient info:', { hasAccount, walletAddress });

      if (hasAccount && walletAddress) {
        console.log('Recipient has account, proceeding with direct transfer');
        // Direct transfer if recipient has account
        const tx = await walletClient.sendTransaction({
          to: parameters.tokenAddress,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [walletAddress, BigInt(parameters.amount)],
        });
        console.log('Direct transfer successful:', { txHash: tx.hash });

        return {
          status: 'success',
          message: `Successfully sent tip to @${normalizedHandle}`,
          transactionHash: tx.hash,
          type: 'direct_transfer',
        };
      } else {
        console.log('Recipient has no account, storing tip in safe wallet');
        // Store in safe wallet if recipient doesn't have account
        console.log('Safe wallet address:', this.safeWalletAddress);

        // Transfer tokens to safe wallet
        console.log('Transferring tokens to safe wallet...');
        const tx = await walletClient.sendTransaction({
          to: parameters.tokenAddress,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [this.safeWalletAddress, BigInt(parameters.amount)],
        });
        console.log('Transfer successful:', { txHash: tx.hash });

        // Store pending tip information
        console.log('Storing pending tip information...');
        await this.storePendingTip({
          xHandle: normalizedHandle,
          tokenAddress: parameters.tokenAddress,
          amount: parameters.amount,
          transactionHash: tx.hash,
          chainId: walletClient.getChain().id.toString(),
        });
        console.log('Pending tip stored successfully');

        return {
          status: 'pending',
          message: `Tip stored safely for @${normalizedHandle}! Log on to https://trymidas.fun to claim it.`,
          transactionHash: tx.hash,
          type: 'pending_claim',
        };
      }
    } catch (error) {
      console.error('Error in sendTip:', error);
      throw new Error(`Failed to send tip: ${error.message}`);
    }
  }

  @Tool({
    name: 'claim_pending_tips',
    description: 'Claim any pending tips for the current wallet address',
  })
  async claimPendingTips(
    walletClient: EVMWalletClient,
    parameters: ClaimPendingTipsParameters,
  ) {
    try {
      console.log('=== Starting claimPendingTips operation ===');
      const walletAddress = await walletClient.getAddress();
      if (!walletAddress) {
        console.error('No wallet address found');
        throw new Error('No wallet address found');
      }
      console.log('Wallet address:', walletAddress);

      // Get pending tips for the wallet address
      console.log('Fetching pending tips...');
      const pendingTips = await this.getPendingTips(
        walletAddress,
        walletClient.getChain().id.toString(),
      );
      console.log('Found pending tips:', pendingTips.length);

      if (!pendingTips.length) {
        console.log('No pending tips found');
        return {
          status: 'info',
          message: 'No pending tips found for this wallet',
          type: 'no_pending_tips',
        };
      }

      const chainId = walletClient.getChain().id.toString();
      console.log('Chain ID:', chainId);

      console.log('Safe wallet address:', this.safeWalletAddress);

      const results = [];

      // Process each pending tip
      console.log('Processing pending tips...');
      for (const tip of pendingTips) {
        console.log('Processing tip:', {
          xHandle: tip.xHandle,
          amount: tip.amount,
          tokenAddress: tip.tokenAddress,
        });

        // Transfer tokens from safe wallet to recipient
        console.log('Transferring tokens to recipient...');
        const tx = await walletClient.sendTransaction({
          to: tip.tokenAddress,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [walletAddress, BigInt(tip.amount)],
        });
        console.log('Transfer successful:', { txHash: tx.hash });

        // Mark tip as claimed
        console.log('Marking tip as claimed...');
        await this.markTipAsClaimed(tip.transactionHash);
        console.log('Tip marked as claimed');

        results.push(tx.hash);
      }

      console.log('All tips processed successfully');
      return {
        status: 'success',
        message: `Successfully claimed ${results.length} pending tip${results.length > 1 ? 's' : ''}`,
        transactionHashes: results,
        type: 'claimed_tips',
        count: results.length,
      };
    } catch (error) {
      console.error('Error in claimPendingTips:', error);
      throw new Error(`Failed to claim pending tips: ${error.message}`);
    }
  }

  private async getRecipientInfo(
    xHandle: string,
  ): Promise<{ hasAccount: boolean; walletAddress?: string }> {
    console.log('Getting recipient info for handle:', xHandle);
    const user = await this.userModel.findOne({ twitterUsername: xHandle });
    console.log('Found user:', user ? 'yes' : 'no');
    return {
      hasAccount: !!user && !!user.wallet,
      walletAddress: user?.wallet,
    };
  }

  private async storePendingTip(tipInfo: {
    xHandle: string;
    tokenAddress: string;
    amount: string;
    transactionHash: string;
    chainId: string;
  }): Promise<void> {
    console.log('Storing pending tip:', tipInfo);
    await this.pendingTipModel.create({
      xHandle: tipInfo.xHandle,
      tokenAddress: tipInfo.tokenAddress,
      amount: tipInfo.amount,
      transactionHash: tipInfo.transactionHash,
      chainId: tipInfo.chainId,
      claimed: false,
    });
    console.log('Pending tip stored successfully');
  }

  private async getPendingTips(
    xHandle: string,
    chainId: string,
  ): Promise<PendingTip[]> {
    console.log(
      'Getting pending tips for handle:',
      xHandle,
      'on chain:',
      chainId,
    );
    const tips = await this.pendingTipModel.find({
      xHandle,
      chainId,
      claimed: false,
    });
    console.log('Found pending tips:', tips.length);
    return tips;
  }

  private async markTipAsClaimed(transactionHash: string): Promise<void> {
    console.log('Marking tip as claimed:', transactionHash);
    await this.pendingTipModel.findOneAndUpdate(
      { transactionHash },
      {
        claimed: true,
        claimedAt: new Date(),
      },
    );
    console.log('Tip marked as claimed successfully');
  }
}
