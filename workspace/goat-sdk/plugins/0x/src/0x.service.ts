import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi, maxUint256, formatUnits } from 'viem';
import { GetPriceParameters } from './parameters';

export class Referrer {
  constructor(
    public readonly swapFeeBps: number,
    public readonly swapFeeRecipient: string,
  ) {
    console.log('Initializing Referrer:', { swapFeeBps, swapFeeRecipient });
  }
}

export class ZeroExService {
  constructor(
    private readonly apiKey: string,
    private readonly referrer?: Referrer,
  ) {
    // Log the API key (partially masked for security)
    const maskedApiKey = this.apiKey
      ? this.apiKey.slice(0, 4) + '****' + this.apiKey.slice(-4)
      : 'undefined';
    console.log(
      'Initializing ZeroExService with apiKey:',
      maskedApiKey,
      'and referrer:',
      referrer,
    );
  }

  private async makeRequest(
    path: string,
    queryParams: Record<string, string | undefined>,
  ) {
    console.log('Making request to 0x API:', { path, queryParams });

    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([key, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(
      `https://api.0x.org${path}?${new URLSearchParams(filteredParams).toString()}`,
    );

    console.log('Request URL:', url.toString());

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        '0x-api-key': this.apiKey,
        '0x-version': 'v2',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('0x API request failed:', {
        status: response.status,
        error: errorText,
      });
      throw new Error(
        `Failed to fetch ${url}: ${JSON.stringify(errorText, null, 2)}`,
      );
    }

    const data = await response.json();
    console.log('0x API response:', data);
    return data;
  }

  // @Tool({
  //   name: '0x_get_price',
  //   description:
  //     "Get the price of a token (don't call this tool, it is called automatically)",
  // })
  async getPrice(
    walletClient: EVMWalletClient,
    parameters: GetPriceParameters,
  ) {
    console.log('Getting price with parameters:', {
      chainId: walletClient.getChain().id,
      sellToken: parameters.sellToken,
      buyToken: parameters.buyToken,
      sellAmount: parameters.sellAmount,
      slippageBps: parameters.slippageBps,
    });

    const queryParams = {
      chainId: walletClient.getChain().id.toString(),
      sellToken: parameters.sellToken,
      buyToken: parameters.buyToken,
      sellAmount: parameters.sellAmount,
      taker: walletClient.getAddress(),
      txOrigin: walletClient.getAddress(),
      slippageBps: parameters.slippageBps?.toString(),
      ...(this.referrer && {
        swapFeeBps: this.referrer.swapFeeBps.toString(),
        swapFeeToken: parameters.sellToken,
        swapFeeRecipient: this.referrer.swapFeeRecipient,
      }),
    };

    return await this.makeRequest('/swap/allowance-holder/price', queryParams);
  }

  @Tool({
    name: '0x_swap',
    description: 'Swap tokens using 0x',
  })
  async swap(walletClient: EVMWalletClient, parameters: GetPriceParameters) {
    console.log('Starting swap operation with parameters:', {
      sellToken: parameters.sellToken,
      buyToken: parameters.buyToken,
      sellAmount: parameters.sellAmount,
      slippageBps: parameters.slippageBps,
    });

    // check sell token balance
    const sellTokenBalance = await walletClient.read({
      address: parameters.sellToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletClient.getAddress()],
    });

    if (
      BigInt(sellTokenBalance.value as string) < BigInt(parameters.sellAmount)
    ) {
      return `You don't have enough balance of ${parameters.sellToken}`;
    }

    // check buy token balance
    const buyTokenBalanceRaw = await walletClient.read({
      address: parameters.buyToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletClient.getAddress()],
    });

    const buyTokenBalance = BigInt(buyTokenBalanceRaw.value as string);

    const price = await this.getPrice(walletClient, parameters);
    console.log('Received price information:', price);

    if (price.issues.allowance !== null) {
      console.log(
        'Handling allowance approval for spender:',
        price.issues.allowance.spender,
      );
      await walletClient.sendTransaction({
        to: parameters.sellToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [price.issues.allowance.spender, maxUint256],
      });
      console.log('Allowance approval transaction sent');
    }

    console.log('Requesting swap quote...');
    const quote = await this.makeRequest('/swap/allowance-holder/quote', {
      chainId: walletClient.getChain().id.toString(),
      sellToken: parameters.sellToken,
      buyToken: parameters.buyToken,
      sellAmount: parameters.sellAmount,
      taker: walletClient.getAddress(),
      txOrigin: walletClient.getAddress(),
      slippageBps: parameters.slippageBps?.toString(),
      ...(this.referrer && {
        swapFeeBps: this.referrer.swapFeeBps.toString(),
        swapFeeToken: parameters.sellToken,
        swapFeeRecipient: this.referrer.swapFeeRecipient,
      }),
    });
    console.log('Received swap quote:', quote);

    const transaction = quote.transaction;
    console.log('Sending final transaction:', {
      to: transaction.to,
      value: transaction.value,
      dataLength: transaction.data.length,
    });

    const tx = await walletClient.sendTransaction({
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
    });

    console.log('Swap transaction sent successfully with hash:', tx.hash);

    // check new buy token balance
    const newBuyTokenBalanceRaw = await walletClient.read({
      address: parameters.buyToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [walletClient.getAddress()],
    });

    const newBuyTokenBalance = BigInt(newBuyTokenBalanceRaw.value as string);

    const receivedAmountInBaseUnits = newBuyTokenBalance - buyTokenBalance;

    // get decimals of buy token
    const decimalsRaw = await walletClient.read({
      address: parameters.buyToken,
      abi: erc20Abi,
      functionName: 'decimals',
    });

    const decimals = Number(decimalsRaw.value);

    const receivedAmount = formatUnits(receivedAmountInBaseUnits, decimals);

    return {
      transactionHash: tx.hash,
      receivedAmount,
    };
  }
}
