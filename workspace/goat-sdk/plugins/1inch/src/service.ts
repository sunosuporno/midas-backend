import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { GetBalancesParameters, SwapParameters } from './parameters';
import {
  AggregatedBalancesAndAllowancesResponse,
  BalanceServiceParams,
  SwapResponse,
} from './types';
import { erc20Abi, maxUint256 } from 'viem';

export class OneInchService {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(params: BalanceServiceParams = {}) {
    this.baseUrl = params.baseUrl ?? 'https://api.1inch.dev';
    this.apiKey = params.apiKey;

    // Debug logging for constructor
    console.log('OneInchService initialized:', {
      baseUrl: this.baseUrl,
      hasApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey?.length || 0,
      apiKeyPrefix: this.apiKey?.substring(0, 8) || 'none',
    });
  }

  private async makeRequest<T>(
    path: string,
    queryParams: Record<string, string | undefined> = {},
  ): Promise<T> {
    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(`${this.baseUrl}${path}`);
    url.search = new URLSearchParams(filteredParams).toString();

    // Debug logging
    console.log('1inch API Request:', {
      url: url.toString(),
      hasApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey?.length || 0,
    });

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    } else {
      console.warn('1inch API key is missing!');
    }

    const response = await fetch(url.toString(), { headers });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => 'Unable to read error response');
      console.error('1inch API Error:', {
        status: response.status,
        statusText: response.statusText,
        url: url.toString(),
        errorText,
        hasApiKey: !!this.apiKey,
      });
      throw new Error(
        `Failed to fetch ${path}: ${response.status} ${response.statusText} - ${errorText}`,
      );
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
    console.log('Chain ID:', chainId);
    const fromAddress = walletClient.getAddress();

    // Get the spender address first
    console.log('Getting spender address...');
    const spenderResponse = await this.makeRequest<{ address: string }>(
      `/swap/v6.0/${chainId}/approve/spender`,
    );
    console.log('Spender address:', spenderResponse.address);

    console.log('Approving token...');
    await walletClient.sendTransaction({
      to: parameters.fromTokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderResponse.address, maxUint256],
    });

    // Get the swap transaction data
    console.log('Getting swap transaction data...');
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
    console.log('Swap transaction data received');

    // Execute the swap
    console.log('Executing swap transaction...');
    const tx = await walletClient.sendTransaction({
      to: swapResponse.tx.to,
      data: swapResponse.tx.data as `0x${string}`,
    });
    console.log('Swap transaction sent:', tx.hash);

    return tx.hash;
  }
}
