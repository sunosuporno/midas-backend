import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi } from 'viem';
import { SendTipParameters, ClaimPendingTipsParameters } from './parameters';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User } from '@/schemas/user.schema';
import { PendingTip } from '@/schemas/pending-tip.schema';
import { ethers } from 'ethers';
import { createWalletClient, http, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum, base } from 'viem/chains';

export class TippingService {
  private wallet: ethers.Wallet;
  private safeWalletAddress: string;
  private rpcUrl: string;

  constructor(
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(PendingTip.name) private pendingTipModel: Model<PendingTip>,
    rpcUrl: string,
    signerPrivateKey: string,
  ) {
    this.wallet = new ethers.Wallet(
      signerPrivateKey,
      new ethers.JsonRpcProvider(rpcUrl),
    );
    this.safeWalletAddress = this.wallet.address;
    this.rpcUrl = rpcUrl;
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

      // First, get the user's Twitter username from the database
      console.log('Looking up user by wallet address...');
      const user = await this.userModel.findOne({ wallet: walletAddress });
      if (!user || !user.twitterUsername) {
        console.log('No Twitter username found for wallet address');
        return {
          status: 'info',
          message: 'No Twitter account found for this wallet',
          type: 'no_twitter_account',
        };
      }
      console.log('Found Twitter username:', user.twitterUsername);

      // Get pending tips for the Twitter username
      console.log('Fetching pending tips...');
      const pendingTips = await this.getPendingTips(
        user.twitterUsername,
        walletClient.getChain().id.toString(),
      );
      console.log('Pending tips length:', pendingTips.length);

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

      const successfulClaims = [];
      const failedClaims = [];

      // Create viem wallet client for the safe wallet
      const chain = chainId === '42161' ? arbitrum : base;
      const account = privateKeyToAccount(
        this.wallet.privateKey as `0x${string}`,
      );
      const safeWalletClient = createWalletClient({
        account,
        transport: http(this.rpcUrl),
        chain,
      });

      // Create public client to get nonce
      const publicClient = createPublicClient({
        transport: http(this.rpcUrl),
        chain,
      });

      // Get the current nonce
      let currentNonce = await publicClient.getTransactionCount({
        address: this.safeWalletAddress as `0x${string}`,
      });
      console.log('Current nonce:', currentNonce);

      // Process each pending tip
      console.log('Processing pending tips...');
      for (const tip of pendingTips) {
        try {
          console.log('Processing tip:', {
            xHandle: tip.xHandle,
            amount: tip.amount,
            tokenAddress: tip.tokenAddress,
          });

          // Transfer tokens from safe wallet to recipient using viem
          console.log('Transferring tokens to recipient...');
          const tx = await safeWalletClient.writeContract({
            account,
            address: tip.tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [walletAddress, BigInt(tip.amount)],
            chain,
            nonce: currentNonce,
          });
          console.log('Transfer successful:', { txHash: tx });

          // Increment nonce for next transaction
          currentNonce++;

          // Mark tip as claimed
          console.log('Marking tip as claimed...');
          await this.markTipAsClaimed(tip.transactionHash);
          console.log('Tip marked as claimed');

          successfulClaims.push({
            transactionHash: tx,
            amount: tip.amount,
            tokenAddress: tip.tokenAddress,
          });
        } catch (error) {
          console.error('Failed to process tip:', error);
          failedClaims.push({
            amount: tip.amount,
            tokenAddress: tip.tokenAddress,
            error: error.message,
          });
        }
      }

      console.log('Tips processing completed');
      const response: {
        status: string;
        message: string;
        type: string;
        successfulClaims: Array<{
          transactionHash: string;
          amount: string;
          tokenAddress: string;
        }>;
        failedClaims: Array<{
          amount: string;
          tokenAddress: string;
          error: string;
        }>;
        totalProcessed: number;
        totalSuccessful: number;
        totalFailed: number;
        error?: string;
      } = {
        status: successfulClaims.length > 0 ? 'partial_success' : 'error',
        message: this.generateResponseMessage(
          successfulClaims.length,
          failedClaims.length,
        ),
        type: 'claimed_tips',
        successfulClaims,
        failedClaims,
        totalProcessed: successfulClaims.length + failedClaims.length,
        totalSuccessful: successfulClaims.length,
        totalFailed: failedClaims.length,
      };

      if (failedClaims.length > 0) {
        response.status = 'partial_success';
        response.error =
          'Some tips failed to be claimed due to gas issues. Please try again later.';
      }

      return response;
    } catch (error) {
      console.error('Error in claimPendingTips:', error);
      throw new Error(`Failed to claim pending tips: ${error.message}`);
    }
  }

  private generateResponseMessage(successful: number, failed: number): string {
    if (successful === 0 && failed === 0) {
      return 'No pending tips found for this wallet';
    }
    if (successful === 0) {
      return 'Failed to claim any pending tips';
    }
    if (failed === 0) {
      return `Successfully claimed ${successful} pending tip${successful > 1 ? 's' : ''}`;
    }
    return `Successfully claimed ${successful} tip${successful > 1 ? 's' : ''}, but ${failed} tip${failed > 1 ? 's' : ''} failed to be claimed`;
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
