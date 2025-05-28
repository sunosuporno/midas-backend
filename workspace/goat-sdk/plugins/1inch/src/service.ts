import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { GetBalancesParameters, SwapParameters } from './parameters';
import {
  AggregatedBalancesAndAllowancesResponse,
  BalanceServiceParams,
  SwapResponse,
} from './types';
import { erc20Abi, MaxFeePerGasTooLowError, maxUint256 } from 'viem';

export class OneInchService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(params: BalanceServiceParams = {}) {
    this.baseUrl = params.baseUrl ?? 'https://api.1inch.dev';
    this.apiKey = params.apiKey;
  }

  private async makeRequest<T>(
    path: string,
    queryParams: Record<string, string | undefined> = {},
  ): Promise<T> {
    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([_, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(`${this.baseUrl}${path}`);
    url.search = new URLSearchParams(filteredParams).toString();

    const response = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
    }

    return response.json();
  }

  @Tool({
    name: '1inch_get_balances',
    description: 'Get the balances of a wallet address on a specific chain',
  })
  async getAggregatedBalancesAndAllowances(
    walletClient: EVMWalletClient,
    parameters: GetBalancesParameters,
  ): Promise<AggregatedBalancesAndAllowancesResponse> {
    const { walletAddress } = parameters;
    const chainId = walletClient.getChain().id;

    return this.makeRequest(
      `/balance/v1.2/${chainId}/balances/${walletAddress ?? walletClient.getAddress()}`,
    );
  }

  @Tool({
    name: '1inch_get_swap_quote',
    description: 'Get a swap quote from 1inch',
  })
  async getSwapQuote(
    walletClient: EVMWalletClient,
    parameters: SwapParameters,
  ): Promise<SwapResponse> {
    const chainId = walletClient.getChain().id;
    const fromAddress = parameters.fromAddress ?? walletClient.getAddress();

    const queryParams = {
      fromTokenAddress: parameters.fromTokenAddress,
      toTokenAddress: parameters.toTokenAddress,
      amount: parameters.amount,
      fromAddress,
      slippage: parameters.slippage?.toString(),
      disableEstimate: 'false',
      allowPartialFill: 'false',
    };

    return this.makeRequest(`/swap/v6.0/${chainId}/quote`, queryParams);
  }

  @Tool({
    name: '1inch_swap',
    description: 'Execute a token swap using 1inch',
  })
  async swap(
    walletClient: EVMWalletClient,
    parameters: SwapParameters,
  ): Promise<string> {
    const chainId = walletClient.getChain().id;
    logger.log('Chain ID:', chainId);
    const fromAddress = walletClient.getAddress();

    // Get the spender address first
    logger.log('Getting spender address...');
    const spenderResponse = await this.makeRequest<{ address: string }>(
      `/swap/v6.0/${chainId}/approve/spender`,
    );
    logger.log('Spender address:', spenderResponse.address);

    logger.log('Approving token...');
    await walletClient.sendTransaction({
      to: parameters.fromTokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderResponse.address, maxUint256],
    });

    // Get the swap transaction data
    logger.log('Getting swap transaction data...');
    const swapParams = {
      src: parameters.fromTokenAddress,
      dst: parameters.toTokenAddress,
      amount: parameters.amount,
      from: fromAddress,
      origin: fromAddress,
      slippage: parameters.slippage?.toString(),
    };

    const swapResponse = await this.makeRequest<{
      tx: { to: string; data: string; value: string };
    }>(`/swap/v6.0/${chainId}/swap`, swapParams);
    logger.log('Swap transaction data received');

    // Execute the swap
    logger.log('Executing swap transaction...');
    const tx = await walletClient.sendTransaction({
      to: swapResponse.tx.to,
      data: swapResponse.tx.data as `0x${string}`,
    });
    logger.log('Swap transaction sent:', tx.hash);

    return tx.hash;
  }
}
