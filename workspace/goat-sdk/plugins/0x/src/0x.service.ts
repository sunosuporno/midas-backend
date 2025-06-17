import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { erc20Abi, maxUint256, formatUnits } from 'viem';
import { GetPriceParameters } from './parameters';

export class Referrer {
  constructor(
    public readonly swapFeeBps: number,
    public readonly swapFeeRecipient: string,
  ) {}
}

export class ZeroExService {
  constructor(
    private readonly apiKey: string,
    private readonly referrer?: Referrer,
  ) {}

  private async makeRequest(
    path: string,
    queryParams: Record<string, string | undefined>,
  ) {
    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(
      `https://api.0x.org${path}?${new URLSearchParams(filteredParams).toString()}`,
    );

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        '0x-api-key': this.apiKey,
        '0x-version': 'v2',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch ${url}: ${JSON.stringify(errorText, null, 2)}`,
      );
    }

    const data = await response.json();
    return data;
  }

  async getPrice(
    walletClient: EVMWalletClient,
    parameters: GetPriceParameters,
  ) {
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

    console.log('Balance check:', {
      sellTokenBalance: sellTokenBalance.value,
      sellAmount: parameters.sellAmount,
      comparison:
        BigInt(sellTokenBalance.value as string) <
        BigInt(parameters.sellAmount),
    });

    const balance = BigInt(sellTokenBalance.value as string);
    const requestedAmount = BigInt(parameters.sellAmount);

    // If requested amount is within 99.99% of balance, use full balance
    if (
      balance > BigInt(0) &&
      requestedAmount * BigInt(10000) > balance * BigInt(9999)
    ) {
      console.log('Adjusting to use full balance');
      parameters.sellAmount = balance.toString();
    } else if (balance < requestedAmount) {
      return `Insufficient balance. Required: ${parameters.sellAmount}, Available: ${sellTokenBalance.value}`;
    } else if (balance === BigInt(0)) {
      return `Cannot perform swap with zero balance of ${parameters.sellToken}`;
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

    if (price.issues.allowance !== null) {
      await walletClient.sendTransaction({
        to: parameters.sellToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [price.issues.allowance.spender, maxUint256],
      });
    }

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
