import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi, maxUint256 } from 'viem';
import { GetQuoteParameters } from './parameters';

export class OdosService {
  constructor() {}

  private async makeRequest(path: string, body: Record<string, any>) {
    const url = new URL(`https://api.odos.xyz${path}`);

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${JSON.stringify(await response.text(), null, 2)}`,
      );
    }

    return response.json();
  }

  @Tool({
    name: 'odos_get_quote',
    description: 'Get a quote for swapping tokens using Odos',
  })
  async getQuote(
    walletClient: EVMWalletClient,
    parameters: GetQuoteParameters,
  ) {
    logger.log('=== Starting Odos GetQuote ===');
    logger.log('Input Parameters:', {
      sellToken: parameters.sellToken,
      buyToken: parameters.buyToken,
      sellAmount: parameters.sellAmount,
      slippageLimitPercent: parameters.slippageLimitPercent || 1,
      walletAddress: walletClient.getAddress(),
      chainId: walletClient.getChain().id,
    });

    const requestBody = {
      chainId: walletClient.getChain().id,
      inputTokens: [
        {
          tokenAddress: parameters.sellToken,
          amount: parameters.sellAmount,
        },
      ],
      outputTokens: [
        {
          tokenAddress: parameters.buyToken,
          proportion: 1,
        },
      ],
      slippageLimitPercent: parameters.slippageLimitPercent || 1,
      userAddr: walletClient.getAddress(),
      disableRFQs: true,
      compact: true,
    };

    logger.log('Request Body:', JSON.stringify(requestBody, null, 2));

    try {
      const quote = await this.makeRequest('/sor/quote/v2', requestBody);
      logger.log('Quote Response:', {
        success: true,
        response: quote,
      });
      logger.log('=== Odos GetQuote Complete ===');
      return quote;
    } catch (error) {
      logger.error('Error in Odos GetQuote:', {
        error: error.message,
        code: error.code,
        requestBody: requestBody,
      });
      throw error;
    }
  }

  @Tool({
    name: 'odos_swap',
    description: 'Swap tokens using Odos',
  })
  async swap(walletClient: EVMWalletClient, parameters: GetQuoteParameters) {
    const quote = await this.getQuote(walletClient, parameters);

    // // Check if approval is needed
    // if (quote.approvalNeeded) {
    //     await walletClient.sendTransaction({
    //         to: quote.approvalNeeded.spender,
    //         abi: erc20Abi,
    //         functionName: "approve",
    //         args: [quote.approvalNeeded.spender, maxUint256],
    //     });
    // }

    // Assemble the transaction
    const assembleRequestBody = {
      userAddr: walletClient.getAddress(),
      pathId: quote.pathId,
      simulate: true,
    };

    const assembledTransaction = await this.makeRequest(
      '/sor/assemble',
      assembleRequestBody,
    );

    const transaction = assembledTransaction.transaction;
    logger.log('transaction', transaction);

    logger.log('Sending approve');
    await walletClient.sendTransaction({
      to: quote.inTokens[0],
      abi: erc20Abi,
      functionName: 'approve',
      args: [transaction.to, quote.inAmounts[0]],
    });

    logger.log('Sending transaction');
    const tx = await walletClient.sendTransaction({
      to: transaction.to,
      data: transaction.data,
    });

    return tx.hash;
  }
}
