import { Injectable, HttpException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CreateAerodromeLpDto } from './dto/create-aerodrome-lp.dto';
import {
  AerodromePosition,
  AerodromePositionDocument,
} from './schemas/aerodrome-position.schema';
import { DailyFees, DailyFeesDocument } from './schemas/daily-fees.schema';
import { AppService } from '../app.service';
import { getPoolConfig, isValidPool, PoolConfig } from './config/pools.config';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createWalletClient, http, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { LiquidityAmountsAbi } from './abis/LiquidityAmounts';
import { TickMathAbi } from './abis/TickMath';
import { poolAbi } from './abis/pool';
import { NonFungiblePositionManagerAbi } from './abis/NonFungiblePositionManager';
import { ERC20_ABI } from './abis/erc20';

// TypeScript interfaces for better type safety
export interface TokenAmounts {
  token0Amount: number;
  token1Amount: number;
  token0Price: number;
  token1Price: number;
  halfUsdcAmount: number;
  rawToken0Amount: string;
  rawToken1Amount: string;
}

export interface TickRange {
  tickCurrent: number;
  tickLower: number;
  tickUpper: number;
  currentPrice: number;
  lowerPrice: number;
  upperPrice: number;
  sqrtPriceX96: string;
  tickSpacing: number;
}

export interface LiquidityAmounts {
  finalLiquidity: string;
  limitingToken: string;
  usedAmounts: {
    token0: {
      symbol: string;
      amount: number;
      rawAmount: string;
    };
    token1: {
      symbol: string;
      amount: number;
      rawAmount: string;
    };
  };
  originalAmounts: {
    token0: {
      symbol: string;
      amount: number;
      rawAmount: string;
    };
    token1: {
      symbol: string;
      amount: number;
      rawAmount: string;
    };
  };
}

// Helper function to get amounts for liquidity
// Removed - now using LiquidityAmounts contract directly

// Helper to decode int24 from hex (handles two's complement)
function decodeInt24(hex: string): number {
  let num = parseInt(hex, 16);
  if (num >= 0x800000) {
    // 2^23
    num -= 0x1000000; // 2^24
  }
  return num;
}

// 1inch types and interfaces
interface OneInchSwapResponse {
  fromToken: {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    logoURI: string;
  };
  toToken: {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    logoURI: string;
  };
  toTokenAmount: string;
  fromTokenAmount: string;
  dstAmount?: string;
  protocols: Array<
    Array<{
      name: string;
      part: number;
      fromTokenAddress: string;
      toTokenAddress: string;
    }>
  >;
  tx: {
    from: string;
    to: string;
    data: string;
    value: string;
    gasPrice: string;
    gas: number;
  };
}

interface OneInchSpenderResponse {
  address: string;
}

@Injectable()
export class AerodromeService {
  // USDC address on Base
  private readonly USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  private readonly USDC_DECIMALS = 6;
  private readonly TICKMATH_ADDRESS =
    '0x6979672EB827C9b84028cCf8FC7183483bc37f07';
  private readonly LIQUIDITY_AMOUNTS_ADDRESS =
    '0xbC04A17E3B57d0eCD60326dc5c1255d8d079B5c4';
  private readonly NON_FUNGIBLE_POSITION_MANAGER_ADDRESS =
    '0x827922686190790b37229fd06084350E74485b72';

  // Transaction retry configuration
  private readonly TRANSACTION_RETRY_CONFIG = {
    maxRetries: 3, // Maximum number of retries
    initialPollAttempts: 30, // Initial 30 seconds
    extendedPollAttempts: 60, // Extended 60 seconds for retries
    pollInterval: 1000, // 1 second between polls
    retryDelayBase: 5000, // Base delay between retries (5 seconds)
    maxRetryDelay: 15000, // Maximum delay between retries (15 seconds)
  };

  constructor(
    @InjectModel(AerodromePosition.name)
    private aerodromePositionModel: Model<AerodromePositionDocument>,
    @InjectModel(DailyFees.name)
    private dailyFeesModel: Model<DailyFeesDocument>,
    private appService: AppService,
    private configService: ConfigService,
  ) {}

  // 1inch API methods
  private async make1inchRequest<T>(
    path: string,
    queryParams: Record<string, string | undefined> = {},
  ): Promise<T> {
    console.log('Making request to 1inch API');

    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(`https://api.1inch.dev${path}`);
    url.search = new URLSearchParams(filteredParams).toString();

    const apiKey = this.configService.get<string>('ONEINCH_API_KEY');
    if (!apiKey) {
      throw new HttpException('ONEINCH_API_KEY not configured', 500);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    console.log('1inch API Request:', {
      url: url.toString(),
      hasApiKey: !!apiKey,
    });

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
      });
      throw new Error(
        `Failed to fetch ${path}: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const data = await response.json();
    console.log('1inch API response:', data);
    return data;
  }

  private async get1inchSwapQuote(
    fromTokenAddress: string,
    toTokenAddress: string,
    amount: string,
    fromAddress: string,
    slippage: number = 0.3, // 0.3% default slippage
  ): Promise<OneInchSwapResponse> {
    console.log('Getting 1inch swap quote with parameters:', {
      fromTokenAddress,
      toTokenAddress,
      amount,
      fromAddress,
      slippage,
    });

    const queryParams = {
      src: fromTokenAddress,
      dst: toTokenAddress,
      amount,
      from: fromAddress,
      origin: fromAddress,
      slippage: slippage.toString(),
      disableEstimate: 'false',
      allowPartialFill: 'false',
    };

    console.log('base.id', base.id);

    const response = await this.make1inchRequest<any>(
      `/swap/v6.0/${base.id}/quote`,
      queryParams,
    );

    // Handle different response formats from 1inch
    if (response.dstAmount) {
      // Simplified response format - we need to get the full quote
      console.log('Received simplified 1inch response, getting full quote...');
      return await this.get1inchFullQuote(
        fromTokenAddress,
        toTokenAddress,
        amount,
        fromAddress,
        slippage,
      );
    }

    return response;
  }

  private async get1inchFullQuote(
    fromTokenAddress: string,
    toTokenAddress: string,
    amount: string,
    fromAddress: string,
    slippage: number,
  ): Promise<OneInchSwapResponse> {
    console.log('Getting full 1inch quote...');

    const queryParams = {
      src: fromTokenAddress,
      dst: toTokenAddress,
      amount,
      from: fromAddress,
      origin: fromAddress,
      slippage: slippage.toString(),
      disableEstimate: 'false',
      allowPartialFill: 'false',
    };

    return await this.make1inchRequest<OneInchSwapResponse>(
      `/swap/v6.0/${base.id}/quote`,
      queryParams,
    );
  }

  private async get1inchSpender(): Promise<string> {
    console.log('Getting 1inch spender address...');
    const response = await this.make1inchRequest<OneInchSpenderResponse>(
      `/swap/v6.0/${base.id}/approve/spender`,
    );
    console.log('1inch spender address:', response.address);
    return response.address;
  }

  private async make0xRequest(
    path: string,
    queryParams: Record<string, string | undefined>,
  ) {
    console.log('Making request to 0x API');

    const filteredParams = Object.fromEntries(
      Object.entries(queryParams).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;

    const url = new URL(
      `https://api.0x.org${path}?${new URLSearchParams(filteredParams).toString()}`,
    );

    const apiKey = this.configService.get<string>('ZEROX_API_KEY');
    if (!apiKey) {
      throw new HttpException('ZEROX_API_KEY not configured', 500);
    }

    // Retry mechanism for 0x API calls
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            '0x-api-key': apiKey,
            '0x-version': 'v2',
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `0x API request failed (attempt ${attempt}/${maxRetries}):`,
            {
              status: response.status,
              error: errorText,
            },
          );

          // Only retry for 5xx errors (server errors) and 429 (rate limit)
          if (
            (response.status >= 500 && response.status < 600) ||
            response.status === 429
          ) {
            if (attempt < maxRetries) {
              const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
              console.log(
                `Retrying 0x API request in ${waitTime}ms (attempt ${attempt}/${maxRetries})`,
              );
              await new Promise((resolve) => setTimeout(resolve, waitTime));
              lastError = new Error(
                `Failed to fetch ${url}: ${JSON.stringify(errorText, null, 2)}`,
              );
              continue;
            }
          }

          throw new Error(
            `Failed to fetch ${url}: ${JSON.stringify(errorText, null, 2)}`,
          );
        }

        const data = await response.json();
        console.log('0x API response:', data);
        return data;
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) {
          const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(
            `Retrying 0x API request in ${waitTime}ms (attempt ${attempt}/${maxRetries}) due to: ${error.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    // If we get here, all retries failed
    throw lastError;
  }

  async get0xPriceForEndpoint(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
  ) {
    // Use a dummy wallet address for price queries
    const dummyWalletAddress = '0xF2de711e43409f64aD848449612Ba4069DE418E5';
    return this.get0xPrice(sellToken, buyToken, sellAmount, dummyWalletAddress);
  }

  async testCalculateTokenAmounts(poolName: string, usdcAmount: number) {
    console.log('=== Testing calculateTokenAmounts ===');
    console.log('Pool:', poolName);
    console.log('USDC Amount:', usdcAmount);

    try {
      // Get pool config
      const poolConfig = getPoolConfig(poolName);
      if (!poolConfig) {
        throw new Error(`Pool not found: ${poolName}`);
      }

      console.log('Pool config:', poolConfig);

      // Call the calculateTokenAmounts function
      const result = await this.calculateTokenAmounts(poolConfig, usdcAmount);

      console.log('Test result:', result);
      return {
        poolName,
        usdcAmount,
        poolConfig: {
          name: poolConfig.name,
          token0: poolConfig.token0,
          token1: poolConfig.token1,
          token0Name: poolConfig.token0Name,
          token1Name: poolConfig.token1Name,
          token0Decimals: poolConfig.token0Decimals,
          token1Decimals: poolConfig.token1Decimals,
        },
        result,
      };
    } catch (error) {
      console.error('Error in testCalculateTokenAmounts:', error);
      throw new Error(`Test failed: ${error.message}`);
    }
  }

  private async getTokenPriceForSwap(
    tokenAddress: string,
    tokenName: string,
    tokenDecimals: number,
  ): Promise<number> {
    if (tokenAddress === this.USDC_ADDRESS) {
      return 1.0; // USDC price is always $1.00
    } else {
      // Use 0x pricing for any non-USDC token
      console.log(`Using 0x pricing for swap calculation (${tokenName})`);

      try {
        // Get 1 token in wei (using token decimals)
        const oneTokenInWei = (10 ** tokenDecimals).toString();

        const oxResponse = await this.get0xPriceForEndpoint(
          tokenAddress, // Use token address
          this.USDC_ADDRESS, // Use existing USDC address
          oneTokenInWei,
        );

        const oxBuyAmount = BigInt(oxResponse.buyAmount);
        const price = Number(oxBuyAmount) / 1e6; // USDC has 6 decimals
        console.log(`0x price for ${tokenName}: $${price}`);
        return price;
      } catch (error) {
        console.error(
          `Failed to get 0x price for ${tokenName}:`,
          error.message,
        );

        // Fallback: Use Pyth Network price oracle
        try {
          console.log(`Attempting Pyth fallback for ${tokenName}`);
          const pythPrice = await this.getTokenPrice(tokenName);
          console.log(`Pyth fallback price for ${tokenName}: $${pythPrice}`);
          return pythPrice;
        } catch (pythError) {
          console.error(
            `Both 0x and Pyth failed for ${tokenName}:`,
            pythError.message,
          );

          // If both 0x and Pyth fail, throw an error to prevent incorrect calculations
          throw new Error(
            `Unable to get price for ${tokenName} - both 0x and Pyth price sources failed`,
          );
        }
      }
    }
  }

  private async get0xPrice(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    walletAddress: string,
  ) {
    if (buyToken == sellToken) {
      return {
        price: 1,
      };
    }
    const slippageBps = 30; // Fixed 0.3% slippage
    console.log('Getting 0x price with parameters:', {
      sellToken,
      buyToken,
      sellAmount,
      walletAddress,
      slippageBps,
    });

    const queryParams = {
      chainId: base.id.toString(),
      sellToken,
      buyToken,
      sellAmount,
      taker: walletAddress,
      txOrigin: walletAddress,
      slippageBps: slippageBps.toString(),
    };

    return await this.make0xRequest(
      '/swap/allowance-holder/price',
      queryParams,
    );
  }

  private async get0xQuote(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    walletAddress: string,
  ) {
    const slippageBps = 30; // Fixed 0.3% slippage
    console.log('Getting 0x quote with parameters:', {
      sellToken,
      buyToken,
      sellAmount,
      walletAddress,
      slippageBps,
    });

    const queryParams = {
      chainId: base.id.toString(),
      sellToken,
      buyToken,
      sellAmount,
      taker: walletAddress,
      txOrigin: walletAddress,
      slippageBps: slippageBps.toString(),
    };

    return await this.make0xRequest(
      '/swap/allowance-holder/quote',
      queryParams,
    );
  }

  private async sendTransaction(
    walletLocator: string,
    contractAddress: string,
    abi: any[],
    functionName: string,
    args: any[],
    value: string = '0',
  ) {
    console.log('=== Sending Transaction via Crossmint ===');
    console.log('Wallet Locator:', walletLocator);
    console.log('Contract Address:', contractAddress);
    console.log('Function:', functionName);
    console.log('Args:', args);
    console.log('Value:', value);

    const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
    const signerPrivateKey = this.configService.get<string>(
      'WALLET_SIGNER_SECRET_KEY',
    );

    if (!apiKey) {
      throw new HttpException('CROSSMINT_SERVER_API_KEY not configured', 500);
    }

    if (!signerPrivateKey) {
      throw new HttpException('WALLET_SIGNER_SECRET_KEY not configured', 500);
    }

    // Encode the function call data using viem
    const data = encodeFunctionData({
      abi: abi,
      functionName: functionName,
      args: args,
    });

    console.log('Encoded Function Data:', data);

    return await this.sendRawTransaction(
      walletLocator,
      contractAddress,
      data,
      value,
    );
  }
  private async sendRawTransaction(
    walletLocator: string,
    contractAddress: string,
    data: string,
    value: string = '0',
  ) {
    console.log('=== Sending Raw Transaction via Crossmint ===');

    const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
    const signerPrivateKey = this.configService.get<string>(
      'WALLET_SIGNER_SECRET_KEY',
    );
    const signerWallet = this.configService.get<string>('SIGNER_WALLET');

    if (!apiKey) {
      throw new HttpException('CROSSMINT_SERVER_API_KEY not configured', 500);
    }

    if (!signerPrivateKey) {
      throw new HttpException('WALLET_SIGNER_SECRET_KEY not configured', 500);
    }

    // Helper function to retry axios calls for 502 errors
    const retryAxiosCall = async (
      axiosCall: () => Promise<any>,
      operation: string,
    ) => {
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          return await axiosCall();
        } catch (error) {
          // Only retry for 502 errors (infrastructure issues)
          if (error.response?.status === 502 && retryCount < maxRetries - 1) {
            retryCount++;
            const waitTime = Math.min(
              2000 * Math.pow(2, retryCount - 1),
              10000,
            );
            console.log(
              `502 error in ${operation}, retrying in ${waitTime}ms (attempt ${retryCount}/${maxRetries})`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            continue;
          }
          throw error; // Re-throw other errors or after max retries
        }
      }
    };

    // Step 1: Create the transaction
    console.log('Step 1: Creating transaction...');
    const createResponse = await retryAxiosCall(
      () =>
        axios.post(
          `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/transactions`,
          {
            params: {
              calls: [
                {
                  to: contractAddress,
                  value: value,
                  data: data,
                },
              ],
              chain: 'base',
              signer: signerWallet,
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-API-KEY': apiKey,
            },
          },
        ),
      'transaction creation',
    );
    const transactionId = createResponse.data.id;
    let status = createResponse.data.status;

    // If transaction is already completed, return the result
    if (status === 'completed' || status === 'success') {
      return {
        id: transactionId,
        status: status,
        transactionHash: createResponse.data.transactionHash,
      };
    }

    // Step 2: If transaction needs approval, sign and approve it
    if (
      status === 'awaiting-approval' &&
      createResponse.data.approvals?.pending
    ) {
      console.log(
        'Step 2: Transaction needs approval, signing and approving...',
      );

      const pendingApproval = createResponse.data.approvals.pending[0];
      const messageToSign = pendingApproval.message;

      if (!signerWallet) {
        throw new HttpException('SIGNER_WALLET not configured', 500);
      }

      // Sign the message with the private key
      const account = privateKeyToAccount(signerPrivateKey as `0x${string}`);
      const alchemyApiKey = this.configService.get<string>(
        'ALCHEMY_API_KEY_BASE',
      );

      if (!alchemyApiKey) {
        throw new HttpException('ALCHEMY_API_KEY_BASE not configured', 500);
      }

      const walletClient = createWalletClient({
        account,
        transport: http(
          `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
        ),
      });

      const signature = await walletClient.signMessage({
        message: { raw: messageToSign as `0x${string}` },
        account: account,
      });

      console.log('Signature generated');

      // Step 3: Approve the transaction
      console.log('Step 3: Approving transaction...');
      const approveResponse = await retryAxiosCall(
        () =>
          axios.post(
            `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/transactions/${transactionId}/approvals`,
            {
              approvals: [
                {
                  signer: signerWallet,
                  signature: signature,
                },
              ],
            },
            {
              headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': apiKey,
              },
            },
          ),
        'transaction approval',
      );

      status = approveResponse.data.status;
    }

    // Step 4: Poll for completion with retry logic
    console.log(
      'Step 4: Polling for transaction completion with retry logic...',
    );
    let finalStatus = status;
    let totalAttempts = 0;
    let retryCount = 0;
    const config = this.TRANSACTION_RETRY_CONFIG;

    while (retryCount <= config.maxRetries) {
      const currentMaxAttempts =
        retryCount === 0
          ? config.initialPollAttempts
          : config.extendedPollAttempts;
      let attempts = 0;

      console.log(
        `Retry ${retryCount + 1}/${config.maxRetries + 1}: Polling for ${currentMaxAttempts} seconds...`,
      );

      while (
        attempts < currentMaxAttempts &&
        (finalStatus === 'pending' || finalStatus === 'awaiting-approval')
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.pollInterval),
        );

        try {
          const statusResponse = await retryAxiosCall(
            () =>
              axios.get(
                `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/transactions/${transactionId}`,
                {
                  headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json',
                  },
                },
              ),
            'status polling',
          );

          finalStatus = statusResponse.data.status;
          totalAttempts++;
          console.log(
            `Poll attempt ${totalAttempts} (retry ${retryCount + 1}): Status = ${finalStatus}`,
          );

          if (finalStatus === 'completed' || finalStatus === 'success') {
            const txHash =
              statusResponse.data.onChain?.txId ||
              statusResponse.data.transactionHash;
            console.log('✅ Transaction completed successfully!', {
              transactionId,
              transactionHash: txHash,
              status: finalStatus,
              totalAttempts,
              retryCount,
            });
            return {
              id: transactionId,
              status: finalStatus,
              transactionHash: txHash,
            };
          } else if (finalStatus === 'failed' || finalStatus === 'error') {
            console.error(`❌ Transaction failed with status: ${finalStatus}`, {
              transactionId,
              error: statusResponse.data.error || 'Unknown error',
            });
            throw new Error(
              `Transaction failed with status: ${finalStatus}. Error: ${statusResponse.data.error || 'Unknown error'}`,
            );
          }
        } catch (error) {
          console.error(
            `Error polling transaction status (attempt ${totalAttempts}):`,
            error,
          );
        }

        attempts++;
      }

      // If we've exhausted the current retry's attempts and still pending
      if (finalStatus === 'pending' || finalStatus === 'awaiting-approval') {
        retryCount++;

        if (retryCount <= config.maxRetries) {
          console.log(
            `⚠️ Transaction still pending after ${currentMaxAttempts} seconds. Retrying... (${retryCount}/${config.maxRetries})`,
          );

          // Wait a bit longer between retries (exponential backoff)
          const retryDelay = Math.min(
            config.retryDelayBase * retryCount,
            config.maxRetryDelay,
          );
          console.log(`Waiting ${retryDelay}ms before retry ${retryCount}...`);
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          console.error(
            `❌ Transaction timed out after ${config.maxRetries + 1} attempts. Final status: ${finalStatus}`,
          );
          throw new Error(
            `Transaction timed out after ${config.maxRetries + 1} attempts (${totalAttempts} total polls). Final status: ${finalStatus}. Transaction ID: ${transactionId}`,
          );
        }
      } else {
        // Transaction is no longer pending (either completed, failed, or error)
        break;
      }
    }

    // Final check - if we get here, something went wrong
    if (finalStatus !== 'completed' && finalStatus !== 'success') {
      console.error(
        `Transaction did not complete successfully. Final status: ${finalStatus}`,
      );
      throw new Error(
        `Transaction did not complete successfully. Final status: ${finalStatus}. Transaction ID: ${transactionId}`,
      );
    }

    // This should never be reached, but just in case
    return {
      id: transactionId,
      status: finalStatus,
      transactionHash: null,
    };
  }

  private async handleTokenApproval(
    walletLocator: string,
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint,
  ) {
    console.log('Handling token approval for:', {
      tokenAddress,
      spenderAddress,
    });

    // ERC20 approve function ABI
    const erc20ApproveAbi = [
      {
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        name: 'approve',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
      },
    ];

    return await this.sendTransaction(
      walletLocator,
      tokenAddress,
      erc20ApproveAbi,
      'approve',
      [spenderAddress as `0x${string}`, amount],
    );
  }

  /**
   * Helper function to get the actual buy amount from Transfer events in a transaction receipt
   */
  private async getBuyAmountFromTransferEvents(
    transactionHash: string,
    buyTokenAddress: string,
    walletAddress: string,
  ): Promise<bigint> {
    const alchemyApiKey = this.configService.get<string>(
      'ALCHEMY_API_KEY_BASE',
    );
    const { createPublicClient, http, decodeEventLog } = await import('viem');

    const publicClient = createPublicClient({
      transport: http(alchemyApiKey),
      chain: base,
    });

    const receipt = await publicClient.getTransactionReceipt({
      hash: transactionHash as `0x${string}`,
    });

    console.log('Transaction receipt logs:', receipt.logs.length);

    let totalBuyAmount = BigInt(0);

    // ERC20 Transfer event topic - use viem's built-in hashing
    const { keccak256, toHex } = await import('viem');
    const transferEventTopic = keccak256(
      toHex('Transfer(address,address,uint256)'),
    );

    for (const log of receipt.logs) {
      try {
        // Check if this is a Transfer event for the buy token
        if (
          log.address.toLowerCase() === buyTokenAddress.toLowerCase() &&
          (log as any).topics?.[0] === transferEventTopic
        ) {
          const event = decodeEventLog({
            abi: ERC20_ABI as any,
            data: (log as any).data,
            topics: (log as any).topics,
          }) as any;

          console.log('Decoded Transfer event:', {
            from: event.args.from,
            to: event.args.to,
            value: event.args.value.toString(),
          });

          // Check if this transfer is TO our wallet
          if (event.args.to.toLowerCase() === walletAddress.toLowerCase()) {
            totalBuyAmount += BigInt(event.args.value);
            console.log(
              'Found transfer TO wallet:',
              event.args.value.toString(),
            );
          }
        }
      } catch (error) {
        console.log('Failed to decode log:', error.message);
      }
    }

    console.log(
      'Total buy amount from Transfer events:',
      totalBuyAmount.toString(),
    );
    return totalBuyAmount;
  }

  private getWalletAddressFromLocator(walletLocator: string): string {
    // Extract wallet address from wallet locator
    // Wallet locator format is typically: "evm-base:0x..."
    const parts = walletLocator.split(':');
    if (parts.length >= 2) {
      return parts[1];
    }
    // If no colon found, assume it's already an address
    return walletLocator;
  }

  private async getOrCreateDailyFeesDocument(
    date: string,
  ): Promise<DailyFeesDocument> {
    let dailyFees = await this.dailyFeesModel.findOne({ date });

    if (!dailyFees) {
      dailyFees = await this.dailyFeesModel.create({
        date,
        totalUsdValue: 0,
        positionFees: {},
        tokenTotals: {},
        totalPositions: 0,
        totalCollections: 0,
      });
    }

    return dailyFees;
  }
  async mint(createAerodromeLpDto: CreateAerodromeLpDto) {
    let positionId = null;
    let position = null;
    let swapResults = null;
    let amount0Used = null;
    let amount1Used = null;
    let mintResult: any = null;
    // Track swap outcomes for dynamic approvals in normal mint mode
    let token0DidSwap = false;
    let token1DidSwap = false;
    let token0BuyAmount: string | null = null;
    let token1BuyAmount: string | null = null;

    console.log('=== Creating Aerodrome LP Position ===');
    console.log('Wallet Locator:', createAerodromeLpDto.walletLocator);
    console.log('USDC Amount:', createAerodromeLpDto.usdcAmount);
    console.log('Pool:', createAerodromeLpDto.pool);

    // Prevent mint calls with 0 USDC amount
    if (
      !createAerodromeLpDto.usdcAmount ||
      createAerodromeLpDto.usdcAmount <= 0
    ) {
      console.error('❌ Invalid USDC amount:', createAerodromeLpDto.usdcAmount);
      return {
        success: false,
        error: 'USDC amount must be greater than 0',
        errorCode: 'INVALID_USDC_AMOUNT',
        positionId: null,
      };
    }

    // Get wallet address from wallet locator
    const walletAddress = this.getWalletAddressFromLocator(
      createAerodromeLpDto.walletLocator,
    );
    console.log('Extracted wallet address:', walletAddress);

    // Check if wallet is currently rebalancing (only for normal mints, not retry/rebalance)
    if (!createAerodromeLpDto.isRebalanceOrRetry) {
      const isRebalancing = await this.isWalletRebalancing(
        createAerodromeLpDto.walletLocator,
      );
      if (isRebalancing) {
        throw new HttpException(
          `Wallet ${createAerodromeLpDto.walletLocator} is currently undergoing rebalancing. Please try again later.`,
          409,
        );
      }
    }

    // BALANCE CHECKS - OUTSIDE TRY-CATCH TO AVOID CLEANUP ISSUES
    if (createAerodromeLpDto.isRebalanceOrRetry) {
      console.log('=== RETRY/REBALANCING MODE ===');

      // For retry/rebalancing: Check if we have enough of the tokens we actually have
      const poolConfig = getPoolConfig(createAerodromeLpDto.pool);
      if (!poolConfig) {
        throw new HttpException(
          `Pool configuration not found for: ${createAerodromeLpDto.pool}`,
          400,
        );
      }

      // Get current token balances
      const [token0Balance, token1Balance] = await Promise.all([
        this.readContract(
          poolConfig.token0,
          ERC20_ABI as unknown as any[],
          'balanceOf',
          [walletAddress],
        ),
        this.readContract(
          poolConfig.token1,
          ERC20_ABI as unknown as any[],
          'balanceOf',
          [walletAddress],
        ),
      ]);

      const token0BalanceBigInt = BigInt(token0Balance);
      const token1BalanceBigInt = BigInt(token1Balance);

      console.log('Current token balances for retry:', {
        token0: poolConfig.token0Name,
        token1: poolConfig.token1Name,
        token0Balance: token0BalanceBigInt.toString(),
        token1Balance: token1BalanceBigInt.toString(),
      });

      // Check if we have enough of the actual amounts we need
      const originalPosition = await this.aerodromePositionModel.findOne({
        positionId: createAerodromeLpDto.positionId,
      });

      if (originalPosition?.metadata?.retryMetadata?.originalTokenAmounts) {
        const storedAmounts =
          originalPosition.metadata.retryMetadata.originalTokenAmounts;
        const requiredToken0Amount = BigInt(storedAmounts.token0);
        const requiredToken1Amount = BigInt(storedAmounts.token1);

        // If we don't have enough balance, wait and retry the balance check
        // This handles the case where fees were just collected but balance hasn't updated yet
        let retryCount = 0;
        const maxRetries = 3;
        let finalToken0Balance = token0BalanceBigInt;
        let finalToken1Balance = token1BalanceBigInt;

        while (
          (finalToken0Balance < requiredToken0Amount ||
            finalToken1Balance < requiredToken1Amount) &&
          retryCount < maxRetries
        ) {
          retryCount++;
          console.log(`Balance check attempt ${retryCount}/${maxRetries}:`);
          console.log(
            `Token0: Required ${requiredToken0Amount}, Available ${finalToken0Balance}`,
          );
          console.log(
            `Token1: Required ${requiredToken1Amount}, Available ${finalToken1Balance}`,
          );

          if (retryCount < maxRetries) {
            // Wait for balance to update (exponential backoff)
            const waitTime = Math.min(
              2000 * Math.pow(2, retryCount - 1),
              10000,
            );
            console.log(`Waiting ${waitTime}ms for balance to update...`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));

            // Refresh balances
            const [newToken0Balance, newToken1Balance] = await Promise.all([
              this.readContract(
                poolConfig.token0,
                ERC20_ABI as unknown as any[],
                'balanceOf',
                [walletAddress],
              ),
              this.readContract(
                poolConfig.token1,
                ERC20_ABI as unknown as any[],
                'balanceOf',
                [walletAddress],
              ),
            ]);

            finalToken0Balance = BigInt(newToken0Balance);
            finalToken1Balance = BigInt(newToken1Balance);

            console.log('Refreshed balances:', {
              token0: finalToken0Balance.toString(),
              token1: finalToken1Balance.toString(),
            });
          }
        }

        // Final balance check with 1% tolerance
        const onePercentToken0 = requiredToken0Amount / 100n;
        const onePercentToken1 = requiredToken1Amount / 100n;

        if (finalToken0Balance < requiredToken0Amount - onePercentToken0) {
          throw new HttpException(
            `Insufficient ${poolConfig.token0Name} balance for retry after ${maxRetries} attempts. Required: ${requiredToken0Amount}, Available: ${finalToken0Balance}, Tolerance: ${onePercentToken0}`,
            400,
          );
        }

        if (finalToken1Balance < requiredToken1Amount - onePercentToken1) {
          throw new HttpException(
            `Insufficient ${poolConfig.token1Name} balance for retry after ${maxRetries} attempts. Required: ${requiredToken1Amount}, Available: ${finalToken1Balance}, Tolerance: ${onePercentToken1}`,
            400,
          );
        }

        console.log(
          '✅ Final balance check passed after',
          retryCount,
          'attempts',
        );
      }

      console.log('✅ Sufficient token balances for retry/rebalancing');
    } else {
      // Original USDC-only balance check for normal mints
      console.log('=== NORMAL MINT MODE ===');

      const balance = await this.readContract(
        this.USDC_ADDRESS,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const balanceBigInt = BigInt(balance);
      if (balanceBigInt < createAerodromeLpDto.usdcAmount) {
        throw new HttpException('Insufficient USDC balance', 400);
      }
    }

    try {
      // Validate pool exists in our configuration
      if (!isValidPool(createAerodromeLpDto.pool)) {
        throw new HttpException(
          `Invalid pool: ${createAerodromeLpDto.pool}. Please check available pools.`,
          400,
        );
      }

      // Get pool configuration
      const poolConfig = getPoolConfig(createAerodromeLpDto.pool);
      if (!poolConfig) {
        throw new HttpException(
          `Pool configuration not found for: ${createAerodromeLpDto.pool}`,
          400,
        );
      }

      // Calculate token amounts for LP position
      const tokenAmounts = await this.calculateTokenAmounts(
        poolConfig,
        createAerodromeLpDto.usdcAmount,
      );

      // Store token prices at mint
      const token0PriceAtMint = tokenAmounts.token0Price;
      const token1PriceAtMint = tokenAmounts.token1Price;

      // Calculate tick range for LP position using percentDeviation from DTO or default to 1.5%
      const percentDeviation =
        createAerodromeLpDto.percentDeviation !== undefined
          ? createAerodromeLpDto.percentDeviation
          : 1.5; // Use provided value or default to 1.5%

      console.log('Mint function received percentDeviation:', {
        fromDto: createAerodromeLpDto.percentDeviation,
        finalValue: percentDeviation,
        type: typeof percentDeviation,
        dtoKeys: Object.keys(createAerodromeLpDto),
        hasPercentDeviation: 'percentDeviation' in createAerodromeLpDto,
        dtoType: typeof createAerodromeLpDto,
        dtoConstructor: createAerodromeLpDto.constructor.name,
      });

      const tickRange = await this.calculateTickRange(
        poolConfig.address,
        poolConfig.tickSpacing,
        percentDeviation,
        createAerodromeLpDto.customTickLower,
        createAerodromeLpDto.customTickUpper,
        createAerodromeLpDto.assumedCurrentTick,
      );

      console.log('Calculated tick range for LP:', tickRange);

      // Handle fee-optimiser strategies: calculate configurable rebalance tick range
      let tickRangeRebalance = null;

      if (createAerodromeLpDto.strategyName === 'fee-optimiser') {
        const rebalanceRange = createAerodromeLpDto.rebalanceRange || 3.0; // Default to 3% if not specified
        console.log(
          `=== FEE-OPTIMISER STRATEGY: Calculating ${rebalanceRange}% rebalance tick range ===`,
        );

        // Calculate rebalance tick range (0.5% is already in tickRange)
        tickRangeRebalance = await this.calculateTickRange(
          poolConfig.address,
          poolConfig.tickSpacing,
          rebalanceRange,
          createAerodromeLpDto.customTickLower,
          createAerodromeLpDto.customTickUpper,
          createAerodromeLpDto.assumedCurrentTick,
        );

        console.log('Fee-optimiser additional data:', {
          rebalanceRange,
          tickRangeRebalance,
        });
      } else if (createAerodromeLpDto.strategyName === 'fee-optimiser-v2') {
        console.log(
          `=== FEE-OPTIMISER-V2 STRATEGY: Using simplified timer-based approach ===`,
        );
        console.log(
          'Fee-optimiser-v2: No rebalance range needed - uses timer-based logic',
        );
      }

      // Calculate liquidity amounts and determine limiting token
      const liquidityAmounts = await this.calculateLiquidityAmounts(
        poolConfig,
        tokenAmounts,
        tickRange,
      );

      console.log('Calculated liquidity amounts:', liquidityAmounts);

      // Generate unique position ID
      positionId = uuidv4();

      // Create position record in database
      position = new this.aerodromePositionModel({
        walletLocator: createAerodromeLpDto.walletLocator,
        pool: createAerodromeLpDto.pool,
        usdcAmount: createAerodromeLpDto.usdcAmount,
        positionId: positionId,
        status: 'pending',
        metadata: {
          poolAddress: poolConfig.address,
          poolName: poolConfig.name,
          fee: poolConfig.fee,
          description: poolConfig.description,
          rebalancedPositionId:
            createAerodromeLpDto.rebalancedPositionId || null,
          strategyName: createAerodromeLpDto.strategyName || null,
          tickRange: {
            tickCurrent: tickRange.tickCurrent,
            tickLower: tickRange.tickLower,
            tickUpper: tickRange.tickUpper,
            currentPrice: tickRange.currentPrice,
            lowerPrice: tickRange.lowerPrice,
            upperPrice: tickRange.upperPrice,
            percentDeviation: percentDeviation,
            tickSpacing: tickRange.tickSpacing,
          },
          // Fee-optimiser specific data
          ...(createAerodromeLpDto.strategyName === 'fee-optimiser' && {
            rebalanceRange: createAerodromeLpDto.rebalanceRange || 3.0,
            tickRangeRebalance,
          }),
          // Fee-optimiser-v2 specific data
          ...(createAerodromeLpDto.strategyName === 'fee-optimiser-v2' &&
            {
              // No rebalanceRange needed for v2 - uses simplified timer-based approach
            }),
          tokenAmounts: {
            token0Amount: tokenAmounts.token0Amount,
            token1Amount: tokenAmounts.token1Amount,
            rawToken0Amount: tokenAmounts.rawToken0Amount,
            rawToken1Amount: tokenAmounts.rawToken1Amount,
          },
          liquidityAmounts: {
            finalLiquidity: liquidityAmounts.finalLiquidity,
            limitingToken: liquidityAmounts.limitingToken,
            usedAmounts: liquidityAmounts.usedAmounts,
          },
          mintDetails: {
            token0PriceAtMint,
            token1PriceAtMint,
            // The rest of mintDetails will be filled after minting
          },
        },
      });

      await position.save();

      // Handle different minting logic based on mode
      if (createAerodromeLpDto.isRebalanceOrRetry) {
        console.log('=== RETRY/REBALANCING MODE: Using stored tokens ===');
        // Call the retry minting function
        const retryResult = await this.handleRetryMinting(
          createAerodromeLpDto,
          poolConfig,
          liquidityAmounts,
        );

        // Extract results from retry function
        amount0Used = retryResult.amount0Used;
        amount1Used = retryResult.amount1Used;
        swapResults = retryResult.swapResults;
      } else {
        console.log('=== NORMAL MINT MODE: Performing token swaps ===');

        // Convert USDC amount to base units (6 decimals)
        const usdcAmountInBaseUnits = BigInt(
          Math.floor(createAerodromeLpDto.usdcAmount * 10 ** 6),
        ).toString();

        console.log('USDC amount in base units:', usdcAmountInBaseUnits);

        // Use fixed slippage of 0.3% (30 bps)
        const slippageBps = 30;
        console.log('Using slippage (bps):', slippageBps);

        // Step 1: Check if token0 needs USDC swap
        let token0SwapResult = null;
        if (poolConfig.token0 !== this.USDC_ADDRESS) {
          // Calculate the required USDC sell amount for token0
          const token0Price = await this.getTokenPriceForSwap(
            poolConfig.token0,
            poolConfig.token0Name,
            poolConfig.token0Decimals,
          );
          const token0AmountHuman =
            Number(liquidityAmounts.usedAmounts.token0.rawAmount) /
            Math.pow(10, poolConfig.token0Decimals);
          const sellAmountUSDC = Math.ceil(
            token0AmountHuman * token0Price * Math.pow(10, this.USDC_DECIMALS),
          );
          // Use the new swapTokens helper
          const { buyAmount, quotedBuyAmount, minBuyAmount, txResult } =
            await this.swapTokens(
              createAerodromeLpDto.walletLocator,
              this.USDC_ADDRESS,
              poolConfig.token0,
              sellAmountUSDC.toString(),
            );
          token0SwapResult = txResult;
          token0BuyAmount = buyAmount;
          token0DidSwap = true;
          // Persist swap analytics for token0 immediately
          swapResults = {
            ...swapResults,
            token0Swap: token0SwapResult
              ? {
                  transactionHash: token0SwapResult.transactionHash,
                  status: token0SwapResult.status,
                  quotedBuyAmount: quotedBuyAmount || null,
                  minBuyAmount: minBuyAmount || null,
                  actualBuyAmount: token0BuyAmount,
                }
              : null,
          };
        } else {
          console.log('Token0 is USDC, no swap needed');
        }

        // Step 4: Check if token1 needs USDC swap
        let token1SwapResult = null;
        if (poolConfig.token1 !== this.USDC_ADDRESS) {
          const token1Price = await this.getTokenPriceForSwap(
            poolConfig.token1,
            poolConfig.token1Name,
            poolConfig.token1Decimals,
          );
          const token1AmountHuman =
            Number(liquidityAmounts.usedAmounts.token1.rawAmount) /
            Math.pow(10, poolConfig.token1Decimals);
          const sellAmountUSDC = Math.ceil(
            token1AmountHuman * token1Price * Math.pow(10, this.USDC_DECIMALS),
          );
          const { buyAmount, quotedBuyAmount, minBuyAmount, txResult } =
            await this.swapTokens(
              createAerodromeLpDto.walletLocator,
              this.USDC_ADDRESS,
              poolConfig.token1,
              sellAmountUSDC.toString(),
            );
          token1SwapResult = txResult;
          token1BuyAmount = buyAmount;
          token1DidSwap = true;
          // Persist swap analytics for token1 immediately
          swapResults = {
            ...swapResults,
            token1Swap: token1SwapResult
              ? {
                  transactionHash: token1SwapResult.transactionHash,
                  status: token1SwapResult.status,
                  quotedBuyAmount: quotedBuyAmount || null,
                  minBuyAmount: minBuyAmount || null,
                  actualBuyAmount: token1BuyAmount,
                }
              : null,
          };
        } else {
          console.log('Token1 is USDC, no swap needed');
        }

        // Ensure swapResults keys exist even if no swap performed
        swapResults = {
          token0Swap:
            swapResults && swapResults.token0Swap
              ? swapResults.token0Swap
              : token0SwapResult
                ? {
                    transactionHash: token0SwapResult.transactionHash,
                    status: token0SwapResult.status,
                  }
                : null,
          token1Swap:
            swapResults && swapResults.token1Swap
              ? swapResults.token1Swap
              : token1SwapResult
                ? {
                    transactionHash: token1SwapResult.transactionHash,
                    status: token1SwapResult.status,
                  }
                : null,
        };

        // Set amounts used placeholder; final amounts will be set from approvals below
        amount0Used = BigInt(liquidityAmounts.usedAmounts.token0.rawAmount);
        amount1Used = BigInt(liquidityAmounts.usedAmounts.token1.rawAmount);
      }

      // Update position with swap results before minting
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          metadata: {
            ...position.metadata,
            ...swapResults,
          },
        },
      );

      // Step 5.5: Approve tokens for NonFungiblePositionManager before minting
      // Check and approve token0
      console.log('Approving token0 for NonFungiblePositionManager');
      const token0BalanceRaw = await this.readContract(
        poolConfig.token0,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token0Balance = BigInt(token0BalanceRaw);
      // Determine approve amount for token0 based on mode
      let approveAmount0: bigint;
      if (createAerodromeLpDto.isRebalanceOrRetry) {
        // Retry mode: use amount0Used from retry function (includes excess USD)
        approveAmount0 =
          amount0Used <= token0Balance ? amount0Used : token0Balance;
      } else {
        // Normal mode: use buyAmount if swapped, otherwise use calculated amount
        if (token0DidSwap && token0BuyAmount) {
          const swapped0 = BigInt(token0BuyAmount);
          approveAmount0 = swapped0 <= token0Balance ? swapped0 : token0Balance;
        } else {
          const desired0 = BigInt(
            liquidityAmounts.usedAmounts.token0.rawAmount,
          );
          approveAmount0 = desired0 <= token0Balance ? desired0 : token0Balance;
        }
      }
      console.log('approveAmount0 (final)', approveAmount0.toString());

      await this.handleTokenApproval(
        createAerodromeLpDto.walletLocator,
        poolConfig.token0,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        approveAmount0,
      );
      // Check and approve token1
      console.log('Approving token1 for NonFungiblePositionManager');
      const token1BalanceRaw = await this.readContract(
        poolConfig.token1,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token1Balance = BigInt(token1BalanceRaw);
      // Determine approve amount for token1 based on mode
      let approveAmount1: bigint;
      if (createAerodromeLpDto.isRebalanceOrRetry) {
        // Retry mode: use amount1Used from retry function (includes excess USD)
        approveAmount1 =
          amount1Used <= token1Balance ? amount1Used : token1Balance;
      } else {
        // Normal mode: use buyAmount if swapped, otherwise use calculated amount
        if (token1DidSwap && token1BuyAmount) {
          const swapped1 = BigInt(token1BuyAmount);
          approveAmount1 = swapped1 <= token1Balance ? swapped1 : token1Balance;
        } else {
          const desired1 = BigInt(
            liquidityAmounts.usedAmounts.token1.rawAmount,
          );
          approveAmount1 = desired1 <= token1Balance ? desired1 : token1Balance;
        }
      }
      console.log('approveAmount1 (final)', approveAmount1.toString());

      await this.handleTokenApproval(
        createAerodromeLpDto.walletLocator,
        poolConfig.token1,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        approveAmount1,
      );

      // Note: swapResults is already set in the if-else block above

      // Update position with swap results before minting
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          metadata: {
            ...position.metadata,
            ...swapResults,
          },
        },
      );

      // Step 6: Mint the LP NFT position on Aerodrome with retry logic for slippage
      // Use the approved/available amounts for minting
      amount0Used = approveAmount0;
      amount1Used = approveAmount1;
      console.log('Amount0 used:', amount0Used);
      console.log('Amount1 used:', amount1Used);

      // Prepare base mint params
      const baseMintParams = {
        token0: poolConfig.token0,
        token1: poolConfig.token1,
        tickSpacing: poolConfig.tickSpacing,
        tickLower: tickRange.tickLower,
        tickUpper: tickRange.tickUpper,
        amount0Desired: amount0Used.toString(),
        amount1Desired: amount1Used.toString(),
        recipient: walletAddress,
        deadline: Math.floor(Date.now() / 1000) + 1800, // 30 min from now
        sqrtPriceX96: 0,
      };

      // Calculate minimum amounts based on strategy
      let slippageTolerance = 0; // Default: no slippage protection
      let strategyNote =
        'No slippage protection - allowing maximum flexibility';

      if (createAerodromeLpDto.strategyName === 'fee-optimiser') {
        slippageTolerance = 0.1; // 10% slippage tolerance for fee-optimiser
        strategyNote =
          'Protecting against excessive slippage while allowing reasonable market movement';
      }
      // fee-optimiser-v2 and vanilla strategies (no strategyName) use 0% slippage

      // Calculate minimum amounts based on slippage tolerance
      let amount0Min: bigint;
      let amount1Min: bigint;

      if (slippageTolerance === 0) {
        // 0% slippage tolerance means no minimum protection - accept any amount
        amount0Min = BigInt(0);
        amount1Min = BigInt(0);
      } else {
        // Apply slippage tolerance calculation
        amount0Min =
          (BigInt(amount0Used) *
            BigInt(Math.floor((1 - slippageTolerance) * 1000))) /
          BigInt(1000);
        amount1Min =
          (BigInt(amount1Used) *
            BigInt(Math.floor((1 - slippageTolerance) * 1000))) /
          BigInt(1000);
      }

      console.log(
        `Attempting mint with ${(slippageTolerance * 100).toFixed(0)}% slippage tolerance...`,
      );

      const mintParams = {
        ...baseMintParams,
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString(),
      };

      console.log(
        `Mint params with ${(slippageTolerance * 100).toFixed(0)}% slippage tolerance:`,
        {
          amount0Desired: amount0Used.toString(),
          amount1Desired: amount1Used.toString(),
          amount0Min: amount0Min.toString(),
          amount1Min: amount1Min.toString(),
          slippageTolerance: `${(slippageTolerance * 100).toFixed(0)}%`,
          strategyName: createAerodromeLpDto.strategyName || 'vanilla',
          note: strategyNote,
        },
      );

      mintResult = await this.sendTransaction(
        createAerodromeLpDto.walletLocator,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'mint',
        [mintParams],
      );

      // Check if the transaction actually succeeded
      if (
        mintResult.status === 'completed' ||
        mintResult.status === 'success'
      ) {
        console.log(
          `Mint successful with ${(slippageTolerance * 100).toFixed(0)}% slippage tolerance:`,
          mintResult,
        );
      } else {
        // Transaction was sent but failed on-chain
        throw new Error(`Transaction failed with status: ${mintResult.status}`);
      }

      // Check if mint was successful before proceeding with post-mint processing
      if (
        !mintResult ||
        (mintResult.status !== 'completed' && mintResult.status !== 'success')
      ) {
        throw new HttpException(
          'Mint failed - no successful transaction result',
          400,
        );
      }

      // Option 1: Fetch transaction receipt and decode logs for mint details
      let decodedMintDetails = null;
      if (mintResult && mintResult.transactionHash) {
        try {
          const alchemyApiKey = this.configService.get<string>(
            'ALCHEMY_API_KEY_BASE',
          );
          const { createPublicClient, http, decodeEventLog } = await import(
            'viem'
          );
          const publicClient = createPublicClient({
            transport: http(alchemyApiKey),
            chain: base,
          });
          const receipt = await publicClient.getTransactionReceipt({
            hash: mintResult.transactionHash as `0x${string}`,
          });
          // Find the correct event log (Mint or IncreaseLiquidity)
          for (const log of receipt.logs) {
            try {
              const logWithTopics = log as any;
              const mintEvent = decodeEventLog({
                abi: NonFungiblePositionManagerAbi as unknown as any[],
                data: logWithTopics.data,
                topics: logWithTopics.topics,
              }) as any;
              if (
                mintEvent.eventName === 'IncreaseLiquidity' ||
                mintEvent.eventName === 'Mint'
              ) {
                decodedMintDetails = {
                  tokenId: mintEvent.args?.tokenId?.toString(),
                  liquidity: mintEvent.args?.liquidity?.toString(),
                  amount0: mintEvent.args?.amount0?.toString(),
                  amount1: mintEvent.args?.amount1?.toString(),
                };
                break;
              }
            } catch {
              // Not the right event, skip
            }
          }
        } catch (err) {
          console.error('Error decoding mint event log:', err);
        }
      }

      // Extract important details from mintResult and decodedMintDetails
      const {
        liquidity,
        amount0,
        amount1,
        transactionHash: mintTxHash,
      } = mintResult || {};

      // Get tokenId from decodedMintDetails (transaction receipt) or mintResult
      const tokenId = decodedMintDetails?.tokenId || mintResult?.tokenId;

      // Calculate unused amounts (amount0Desired - amount0, amount1Desired - amount1)
      function sanitizeBigIntString(val: any): string {
        if (typeof val === 'string') {
          return val.replace(/[^0-9\-]/g, ''); // Remove commas, whitespace, etc.
        }
        if (typeof val === 'number' || typeof val === 'bigint') {
          return val.toString();
        }
        return '0';
      }

      const amount0Desired = amount0Used
        ? sanitizeBigIntString(amount0Used)
        : '0';
      const amount1Desired = amount1Used
        ? sanitizeBigIntString(amount1Used)
        : '0';
      // Determine actualAmount0 and actualAmount1 from decodedMintDetails or mintResult
      let actualAmount0 = '0';
      let actualAmount1 = '0';
      if (decodedMintDetails && typeof decodedMintDetails === 'object') {
        if (decodedMintDetails.amount0 && decodedMintDetails.amount0 !== '0') {
          actualAmount0 = sanitizeBigIntString(decodedMintDetails.amount0);
        }
        if (decodedMintDetails.amount1 && decodedMintDetails.amount1 !== '0') {
          actualAmount1 = sanitizeBigIntString(decodedMintDetails.amount1);
        }
      }
      // Fallback to mintResult if decodedMintDetails is missing or zero
      if (
        (!actualAmount0 || actualAmount0 === '0') &&
        mintResult &&
        mintResult.amount0
      ) {
        actualAmount0 = sanitizeBigIntString(mintResult.amount0);
      }
      if (
        (!actualAmount1 || actualAmount1 === '0') &&
        mintResult &&
        mintResult.amount1
      ) {
        actualAmount1 = sanitizeBigIntString(mintResult.amount1);
      }
      console.log('[MINT UNUSED DEBUG]', {
        amount0Desired,
        actualAmount0,
        amount0Unused: (
          BigInt(amount0Desired) - BigInt(actualAmount0)
        ).toString(),
        amount1Desired,
        actualAmount1,
        amount1Unused: (
          BigInt(amount1Desired) - BigInt(actualAmount1)
        ).toString(),
      });

      // Validate that mint actually succeeded with non-zero amounts and valid tokenId
      console.log('🔍 Starting mint validation...');
      console.log('Validation inputs:', {
        actualAmount0,
        actualAmount1,
        tokenId,
        decodedMintDetails: decodedMintDetails
          ? {
              tokenId: decodedMintDetails.tokenId,
              liquidity: decodedMintDetails.liquidity,
              amount0: decodedMintDetails.amount0,
              amount1: decodedMintDetails.amount1,
            }
          : null,
        mintResult: mintResult
          ? {
              tokenId: mintResult.tokenId,
              liquidity: mintResult.liquidity,
              amount0: mintResult.amount0,
              amount1: mintResult.amount1,
              transactionHash: mintResult.transactionHash,
            }
          : null,
      });

      const validationChecks = {
        actualAmount0Valid: actualAmount0 && actualAmount0 !== '0',
        actualAmount1Valid: actualAmount1 && actualAmount1 !== '0',
        tokenIdValid: !!tokenId,
        // Allow single-token positions - at least one token must be used
        atLeastOneTokenUsed:
          (actualAmount0 && actualAmount0 !== '0') ||
          (actualAmount1 && actualAmount1 !== '0'),
      };

      console.log('Validation check results:', validationChecks);

      // Updated validation: require tokenId and at least one token to be used
      if (!tokenId || !validationChecks.atLeastOneTokenUsed) {
        console.log(
          '❌ Mint validation failed - missing tokenId or no tokens used',
        );
        console.log('Mint validation details:', {
          actualAmount0,
          actualAmount1,
          amount0Desired,
          amount1Desired,
          tokenId,
          positionId,
          validationChecks,
        });

        // Mark position as failed
        await this.aerodromePositionModel.findOneAndUpdate(
          { positionId },
          { status: 'mint_failed' },
        );

        // Call cleanup with retry enabled
        console.log('🔄 Initiating cleanup and retry for failed mint...');
        await this.cleanupFailedMint(
          positionId,
          actualAmount0,
          actualAmount1,
          true,
        );

        throw new HttpException(
          `Mint failed - missing tokenId or no tokens used. Cleanup and retry initiated.`,
          400,
        );
      }

      console.log(
        '✅ Mint validation passed - position has valid tokenId and at least one token used',
      );
      console.log('✅ Validation summary:', {
        tokenId,
        actualAmount0,
        actualAmount1,
        liquidity,
        transactionHash: mintTxHash || mintResult?.transactionHash,
      });

      // Update DB with mint result and important details
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          status: 'active',
          transactionHash: mintTxHash || mintResult?.transactionHash,
          lpTokens: liquidity || undefined,
          metadata: {
            ...position.metadata,
            token0Swap: swapResults?.token0Swap || null,
            token1Swap: swapResults?.token1Swap || null,
            mint: mintResult,
            mintDetails: {
              token0PriceAtMint,
              token1PriceAtMint,
              ...(decodedMintDetails && typeof decodedMintDetails === 'object'
                ? decodedMintDetails
                : {
                    tokenId,
                    liquidity,
                    amount0,
                    amount1,
                    transactionHash: mintTxHash || mintResult?.transactionHash,
                  }),
              amount0Desired,
              amount1Desired,
              amount0Unused: (
                BigInt(amount0Desired) - BigInt(actualAmount0)
              ).toString(),
              amount1Unused: (
                BigInt(amount1Desired) - BigInt(actualAmount1)
              ).toString(),
            },
            finalSlippageUsed: 10, // 10% slippage tolerance used for minting
          },
        },
      );

      // If this is a rebalancing mint, update the old position status
      if (createAerodromeLpDto.rebalancedPositionId) {
        try {
          console.log(
            `Updating old position ${createAerodromeLpDto.rebalancedPositionId} status to rebalanced`,
          );

          await this.aerodromePositionModel.findOneAndUpdate(
            { positionId: createAerodromeLpDto.rebalancedPositionId },
            {
              status: 'rebalanced',
              $unset: {
                'metadata.rebalancingInfo.isRebalancing': 1,
              },
              $set: {
                'metadata.rebalancingInfo.completedAt':
                  new Date().toISOString(),
                'metadata.rebalancingInfo.success': true,
                'metadata.rebalancingInfo.newPositionId': positionId,
                'metadata.rebalancingInfo.mintTransactionHash':
                  mintTxHash || mintResult?.transactionHash,
              },
            },
          );

          console.log(
            `✅ Successfully updated old position ${createAerodromeLpDto.rebalancedPositionId} to rebalanced status`,
          );
        } catch (updateError) {
          console.error(
            `Failed to update old position ${createAerodromeLpDto.rebalancedPositionId} status:`,
            updateError,
          );
        }
      }

      // Return the position details after mint, surfacing important mint details
      return {
        positionId: positionId,
        status: 'active',
        message: 'LP position created and minted successfully',
        details: {
          walletLocator: createAerodromeLpDto.walletLocator,
          pool: createAerodromeLpDto.pool,
          poolName: poolConfig.name,
          usdcAmount: createAerodromeLpDto.usdcAmount,
          poolAddress: poolConfig.address,
          fee: poolConfig.fee,
          tickRange: tickRange,
          tokenAmounts: {
            token0Amount: tokenAmounts.token0Amount,
            token1Amount: tokenAmounts.token1Amount,
            rawToken0Amount: tokenAmounts.rawToken0Amount,
            rawToken1Amount: tokenAmounts.rawToken1Amount,
          },
          liquidityAmounts: liquidityAmounts,
          swaps: swapResults,
          mint: mintResult,
          mintDetails: {
            token0PriceAtMint,
            token1PriceAtMint,
            ...(decodedMintDetails && typeof decodedMintDetails === 'object'
              ? decodedMintDetails
              : {
                  tokenId,
                  liquidity,
                  amount0,
                  amount1,
                  transactionHash: mintTxHash || mintResult?.transactionHash,
                }),
            amount0Desired,
            amount1Desired,
            amount0Unused: (
              BigInt(amount0Desired) - BigInt(actualAmount0)
            ).toString(),
            amount1Unused: (
              BigInt(amount1Desired) - BigInt(actualAmount1)
            ).toString(),
          },
          finalSlippageUsed: 10, // 10% slippage tolerance used for minting
        },
      };
    } catch (error) {
      console.error('Error in Aerodrome mint:', error);

      // Check if this is a successful mint that encountered an error in post-processing
      // If mintResult exists and has a successful status, don't trigger cleanup
      if (
        mintResult &&
        (mintResult.status === 'completed' || mintResult.status === 'success')
      ) {
        console.log(
          'Mint was successful but encountered error in post-processing. Not triggering cleanup.',
        );
        throw new HttpException(
          error.message || 'Mint succeeded but post-processing failed',
          error.status || 500,
        );
      }

      // Update position status to failed if we have a positionId
      if (positionId) {
        try {
          // Check if any swaps were performed using the in-memory swap results
          const hasToken0Swap =
            swapResults?.token0Swap !== null &&
            swapResults?.token0Swap !== undefined;
          const hasToken1Swap =
            swapResults?.token1Swap !== null &&
            swapResults?.token1Swap !== undefined;

          console.log(
            `Position ${positionId} error handling - swaps performed: Token0: ${hasToken0Swap}, Token1: ${hasToken1Swap}`,
          );

          // Get the actual amounts that were used in the mint (amount0Desired and amount1Desired)
          // These are the amounts that were actually approved and used in the mint function
          const actualAmount0Used = amount0Used ? amount0Used.toString() : '0';
          const actualAmount1Used = amount1Used ? amount1Used.toString() : '0';

          // Update status to mint_failed so cleanup function can process it
          await this.aerodromePositionModel.findOneAndUpdate(
            { positionId },
            {
              status: 'mint_failed',
              metadata: {
                ...(position?.metadata || {}),
                ...swapResults, // Include swap results in metadata
                error: error.message,
                errorType: error.constructor.name,
                failedAt: new Date().toISOString(),
              },
            },
          );

          // Clean up the failed position and attempt immediate retry
          // Pass the actual amounts that were used in the mint, not the original intended amounts
          const cleanupResult = await this.cleanupFailedMint(
            positionId,
            actualAmount0Used,
            actualAmount1Used,
            true, // Enable immediate retry
          );

          // If retry was successful, return the retry result
          if (cleanupResult.retrySuccessful) {
            console.log(`✅ Position ${positionId} successfully retried`);
            return cleanupResult;
          }

          console.log(`Position ${positionId} cleaned up after mint failure`);
        } catch (updateError) {
          console.error('Failed to update position status:', updateError);
        }
      }

      throw new HttpException(
        error.message || 'Failed to create LP position',
        error.status || 500,
      );
    }
  }

  async getPosition(positionId: string) {
    try {
      const position = await this.aerodromePositionModel.findOne({
        positionId,
      });
      if (!position) {
        throw new HttpException('Position not found', 404);
      }
      return position;
    } catch (error) {
      console.error('Error fetching position:', error);
      throw new HttpException(
        error.message || 'Failed to fetch position',
        error.status || 500,
      );
    }
  }

  async getPositionsByWallet(walletLocator: string) {
    try {
      const positions = await this.aerodromePositionModel
        .find({ walletLocator })
        .sort({ createdAt: -1 });
      return positions;
    } catch (error) {
      console.error('Error fetching positions:', error);
      throw new HttpException(
        error.message || 'Failed to fetch positions',
        error.status || 500,
      );
    }
  }

  async getAvailablePools() {
    try {
      const { getAllPools } = await import('./config/pools.config');
      const pools = getAllPools();

      return pools.map((pool) => ({
        name: pool.name,
        address: pool.address,
        token0: pool.token0,
        token1: pool.token1,
        token0Name: pool.token0Name,
        token1Name: pool.token1Name,
        fee: pool.fee,
        description: pool.description,
      }));
    } catch (error) {
      console.error('Error fetching available pools:', error);
      throw new HttpException(
        error.message || 'Failed to fetch available pools',
        error.status || 500,
      );
    }
  }

  async getSwapQuote(walletLocator: string, pool: string, usdcAmount: number) {
    try {
      console.log('=== Getting Swap Quote ===');
      console.log('Wallet Locator:', walletLocator);
      console.log('Pool:', pool);
      console.log('USDC Amount:', usdcAmount);
      console.log('Slippage (bps): 30 (0.3%)');

      // Validate pool exists
      if (!isValidPool(pool)) {
        throw new HttpException(
          `Invalid pool: ${pool}. Please check available pools.`,
          400,
        );
      }

      // Get pool configuration
      const poolConfig = getPoolConfig(pool);
      if (!poolConfig) {
        throw new HttpException(
          `Pool configuration not found for: ${pool}`,
          400,
        );
      }

      // Get wallet address from wallet locator
      const walletAddress = this.getWalletAddressFromLocator(walletLocator);
      console.log('Extracted wallet address:', walletAddress);

      // Convert USDC amount to base units (6 decimals)
      const usdcAmountInBaseUnits = BigInt(
        Math.floor(usdcAmount * 10 ** 6),
      ).toString();

      console.log('USDC amount in base units:', usdcAmountInBaseUnits);

      // Try to get quotes from both 0x and 1inch
      let token0Price = null;
      let token1Price = null;
      let quoteSource = 'unknown';

      try {
        // Try 0x first
        console.log('Getting quotes from 0x...');
        token0Price = await this.get0xPrice(
          poolConfig.token1, // USDC
          poolConfig.token0, // First token in pool
          usdcAmountInBaseUnits,
          walletAddress,
        );

        if (poolConfig.token0 !== poolConfig.token1) {
          token1Price = await this.get0xPrice(
            poolConfig.token1, // USDC
            poolConfig.token1, // Second token in pool
            usdcAmountInBaseUnits,
            walletAddress,
          );
        }
        quoteSource = '0x';
      } catch (oxError) {
        console.error('0x quotes failed, trying 1inch:', oxError);

        try {
          // Fall back to 1inch
          console.log('Getting quotes from 1inch...');
          const slippagePercent = 0.3; // Fixed 0.3% slippage

          token0Price = await this.get1inchSwapQuote(
            poolConfig.token1, // USDC
            poolConfig.token0, // First token in pool
            usdcAmountInBaseUnits,
            walletAddress,
            slippagePercent,
          );

          if (poolConfig.token0 !== poolConfig.token1) {
            token1Price = await this.get1inchSwapQuote(
              poolConfig.token1, // USDC
              poolConfig.token1, // Second token in pool
              usdcAmountInBaseUnits,
              walletAddress,
              slippagePercent,
            );
          }
          quoteSource = '1inch';
        } catch (oneInchError) {
          console.error('Both 0x and 1inch quotes failed:', {
            oxError: oxError.message,
            oneInchError: oneInchError.message,
          });
          throw new Error(
            `Failed to get quotes from both 0x and 1inch. 0x error: ${oxError.message}. 1inch error: ${oneInchError.message}`,
          );
        }
      }

      // Format response based on quote source
      const formatQuote = (quote: any, sellToken: string, buyToken: string) => {
        if (quoteSource === '0x') {
          return {
            sellToken,
            buyToken,
            sellAmount: usdcAmountInBaseUnits,
            buyAmount: quote.buyAmount,
            price: quote.price,
            estimatedGas: quote.estimatedGas,
            allowance: quote.issues?.allowance || null,
          };
        } else {
          // 1inch format - handle both full and simplified responses
          let buyAmount = '0';
          let estimatedGas = 0;

          if (quote.dstAmount) {
            // Simplified response format
            buyAmount = quote.dstAmount;
            estimatedGas = 200000; // Default gas estimate
          } else if (quote.toTokenAmount) {
            // Full response format
            buyAmount = quote.toTokenAmount;
            estimatedGas = quote.tx?.gas || 200000;
          }

          return {
            sellToken,
            buyToken,
            sellAmount: usdcAmountInBaseUnits,
            buyAmount,
            price: null, // 1inch doesn't provide price in the same format
            estimatedGas,
            allowance: null, // Will be handled during swap
          };
        }
      };

      return {
        pool: {
          name: poolConfig.name,
          address: poolConfig.address,
          token0: poolConfig.token0,
          token1: poolConfig.token1,
          token0Name: poolConfig.token0Name,
          token1Name: poolConfig.token1Name,
          fee: poolConfig.fee,
        },
        usdcAmount,
        quoteSource,
        quotes: {
          token0: formatQuote(
            token0Price,
            poolConfig.token1,
            poolConfig.token0,
          ),
          token1: token1Price
            ? formatQuote(token1Price, poolConfig.token1, poolConfig.token1)
            : null,
        },
        totalEstimatedGas:
          (token0Price?.estimatedGas || token0Price?.tx?.gas || 0) +
          (token1Price?.estimatedGas || token1Price?.tx?.gas || 0),
      };
    } catch (error) {
      console.error('Error getting swap quote:', error);
      throw new HttpException(
        error.message || 'Failed to get swap quote',
        error.status || 500,
      );
    }
  }

  private async handleRetryMinting(
    createAerodromeLpDto: CreateAerodromeLpDto,
    poolConfig: PoolConfig,
    liquidityAmounts: LiquidityAmounts,
  ): Promise<{
    amount0Used: bigint;
    amount1Used: bigint;
    swapResults: any;
  }> {
    console.log('=== HANDLING RETRY MINTING ===');

    // Get the stored token amounts from the original position
    const originalPosition = await this.aerodromePositionModel.findOne({
      positionId: createAerodromeLpDto.positionId,
    });

    if (!originalPosition?.metadata?.retryMetadata?.originalTokenAmounts) {
      throw new Error('No retry metadata found for position');
    }

    const storedAmounts =
      originalPosition.metadata.retryMetadata.originalTokenAmounts;

    console.log('Using stored token amounts for retry:', {
      token0: storedAmounts.token0,
      token1: storedAmounts.token1,
    });

    // $A and $B are the stored amounts we have
    const A = BigInt(storedAmounts.token0);
    const B = BigInt(storedAmounts.token1);

    // $a and $b are the calculated optimal amounts
    const a = BigInt(liquidityAmounts.usedAmounts.token0.rawAmount);
    const b = BigInt(liquidityAmounts.usedAmounts.token1.rawAmount);

    console.log('Token amounts comparison:', {
      storedToken0: A.toString(),
      storedToken1: B.toString(),
      calculatedToken0: a.toString(),
      calculatedToken1: b.toString(),
    });

    // Get current token prices
    let token0Price = 1; // USDC is always $1
    let token1Price = 1; // USDC is always $1

    if (poolConfig.token0 !== this.USDC_ADDRESS) {
      token0Price = await this.getTokenPriceForSwap(
        poolConfig.token0,
        poolConfig.token0Name,
        poolConfig.token0Decimals,
      );
    }
    if (poolConfig.token1 !== this.USDC_ADDRESS) {
      token1Price = await this.getTokenPriceForSwap(
        poolConfig.token1,
        poolConfig.token1Name,
        poolConfig.token1Decimals,
      );
    }

    console.log('Current token prices:', {
      token0Price,
      token1Price,
    });

    // Calculate USD values
    const A_USD =
      (Number(A) / Math.pow(10, poolConfig.token0Decimals)) * token0Price;
    const B_USD =
      (Number(B) / Math.pow(10, poolConfig.token1Decimals)) * token1Price;
    const a_USD =
      (Number(a) / Math.pow(10, poolConfig.token0Decimals)) * token0Price;
    const b_USD =
      (Number(b) / Math.pow(10, poolConfig.token1Decimals)) * token1Price;

    console.log('USD values:', {
      A_USD: A_USD.toFixed(2),
      B_USD: B_USD.toFixed(2),
      a_USD: a_USD.toFixed(2),
      b_USD: b_USD.toFixed(2),
    });

    // Check if USD values match (they should be equal)
    const totalStoredUSD = A_USD + B_USD;
    const totalCalculatedUSD = a_USD + b_USD;
    const usdDifference = totalStoredUSD - totalCalculatedUSD;

    console.log('Total USD comparison:', {
      totalStoredUSD: totalStoredUSD.toFixed(2),
      totalCalculatedUSD: totalCalculatedUSD.toFixed(2),
      difference: Math.abs(usdDifference).toFixed(2),
    });

    // Note the excess amount and add it to the token with bigger value
    if (usdDifference > 0.01) {
      console.log(
        `Excess USD detected: $${usdDifference.toFixed(
          2,
        )}. Will add to token with bigger value.`,
      );
    }

    // Calculate the difference: $A*price - $a*price = $b*price - $B*price
    const token0Difference = A_USD - a_USD;
    const token1Difference = b_USD - B_USD;

    console.log('Token differences:', {
      token0Difference: token0Difference.toFixed(2),
      token1Difference: token1Difference.toFixed(2),
    });

    const swapResults = {
      token0Swap: null,
      token1Swap: null,
    };

    let amount0Used = BigInt(0);
    let amount1Used = BigInt(0);

    // Determine if we need to swap and in which direction
    if (Math.abs(token0Difference) > 0.01) {
      // Small threshold to avoid dust
      if (token0Difference > 0) {
        // We have more token0 than needed, swap token0 to token1
        console.log('Need to swap token0 to token1');

        // Calculate sell amount: (token0Difference/token0Price) * 10^token0Decimals
        const sellAmountToken0 = Math.floor(
          (token0Difference / token0Price) *
            Math.pow(10, poolConfig.token0Decimals),
        );

        console.log('Swap details:', {
          sellToken: poolConfig.token0Name,
          buyToken: poolConfig.token1Name,
          sellAmount: sellAmountToken0.toString(),
          token0Difference: token0Difference.toFixed(2),
          token0Price,
        });

        // Perform the swap: token0 to token1
        const { buyAmount, txResult } = await this.swapTokens(
          createAerodromeLpDto.walletLocator,
          poolConfig.token0,
          poolConfig.token1,
          sellAmountToken0.toString(),
        );

        console.log('Buy amount:', buyAmount);

        // Add excess to token with bigger value (token0 in this case since A_USD > a_USD)
        let finalAmount0 = A - BigInt(sellAmountToken0);
        const finalAmount1 = BigInt(buyAmount) + B;

        if (usdDifference > 0.01) {
          const excessToken0 = BigInt(
            Math.floor(
              (usdDifference / token0Price) *
                Math.pow(10, poolConfig.token0Decimals),
            ),
          );
          finalAmount0 = finalAmount0 + excessToken0;
          console.log(
            `Added excess of ${excessToken0.toString()} to token0 (bigger value)`,
          );
        }

        amount0Used = finalAmount0;
        amount1Used = finalAmount1;
        console.log('Amount0 used:', amount0Used.toString());
        console.log('Amount1 used:', amount1Used.toString());

        swapResults.token0Swap = {
          transactionHash: txResult.transactionHash,
          status: txResult.status,
        };
      } else {
        // We have less token0 than needed, swap token1 to token0
        console.log('Need to swap token1 to token0');

        // Calculate sell amount: (token1Difference/token1Price) * 10^token1Decimals
        const sellAmountToken1 = Math.floor(
          (Math.abs(token0Difference) / token1Price) *
            Math.pow(10, poolConfig.token1Decimals),
        );

        console.log('Swap details:', {
          sellToken: poolConfig.token1Name,
          buyToken: poolConfig.token0Name,
          sellAmount: sellAmountToken1.toString(),
          token1Difference: Math.abs(token0Difference).toFixed(2),
          token1Price,
        });

        // Perform the swap: token1 to token0
        const { buyAmount, txResult } = await this.swapTokens(
          createAerodromeLpDto.walletLocator,
          poolConfig.token1,
          poolConfig.token0,
          sellAmountToken1.toString(),
        );

        console.log('Buy amount:', buyAmount);

        // Add excess to token with bigger value (token1 in this case since B_USD > b_USD)
        const finalAmount0 = BigInt(buyAmount) + A;
        let finalAmount1 = B - BigInt(sellAmountToken1);

        if (usdDifference > 0.01) {
          const excessToken1 = BigInt(
            Math.floor(
              (usdDifference / token1Price) *
                Math.pow(10, poolConfig.token1Decimals),
            ),
          );
          finalAmount1 = finalAmount1 + excessToken1;
          console.log(
            `Added excess of ${excessToken1.toString()} to token1 (bigger value)`,
          );
        }

        amount0Used = finalAmount0;
        amount1Used = finalAmount1;
        console.log('Amount0 used:', amount0Used.toString());
        console.log('Amount1 used:', amount1Used.toString());

        swapResults.token1Swap = {
          transactionHash: txResult.transactionHash,
          status: txResult.status,
        };
      }
    } else {
      console.log('No rebalancing needed, amounts are close enough');
      // Use the calculated optimal amounts
      amount0Used = a;
      amount1Used = b;
    }

    // // For now, use the calculated amounts (a and b) as the target amounts
    // const amount0Used = a;
    // const amount1Used = b;

    console.log('Final amounts to use:', {
      amount0Used: amount0Used.toString(),
      amount1Used: amount1Used.toString(),
    });

    return {
      amount0Used,
      amount1Used,
      swapResults,
    };
  }
  async getTokenPrice(tokenName: string): Promise<number> {
    try {
      console.log('Getting price for token:', tokenName);

      // Try Pyth Network first
      const pythResponse = await fetch(
        `https://hermes.pyth.network/v2/price_feeds?query=${tokenName.toLowerCase()}&asset_type=crypto`,
      );
      const pythData = await pythResponse.json();

      if (!pythData[0]?.id) {
        throw new Error(`Price feed not found for token: ${tokenName}`);
      }

      // Get latest price from Pyth
      const priceResponse = await fetch(
        `https://hermes.pyth.network/v2/updates/price/latest?ids%5B%5D=${pythData[0].id}&encoding=hex&parsed=true`,
      );
      const priceData = await priceResponse.json();

      // Calculate USD value (convert from raw format to actual USD)
      const price = Number(priceData.parsed[0].price.price) / 1e8;

      console.log(`Pyth price for ${tokenName}: $${price}`);
      return price;
    } catch (error) {
      console.error(`Pyth failed for ${tokenName}:`, error.message);

      // If Pyth fails, throw an error to prevent incorrect calculations
      throw new Error(
        `Unable to get price for ${tokenName} - Pyth price source failed`,
      );
    }
  }

  private toRawAmount(amount: number, decimals: number): bigint {
    return BigInt(Math.floor(amount * 10 ** decimals));
  }

  private async readContract(
    contractAddress: string,
    abi: any[],
    functionName: string,
    args: any[] = [],
  ) {
    console.log('=== Reading Contract ===');
    console.log('Contract Address:', contractAddress);
    console.log('Function:', functionName);
    console.log('Args:', args);

    const alchemyApiKey = this.configService.get<string>(
      'ALCHEMY_API_KEY_BASE',
    );

    if (!alchemyApiKey) {
      throw new HttpException('ALCHEMY_API_KEY_BASE not configured', 500);
    }

    // Encode the function call data
    const data = encodeFunctionData({
      abi: abi,
      functionName: functionName,
      args: args,
    });

    console.log('Encoded Function Data:', data);

    // Create a public client to read from the contract
    const { createPublicClient, http } = await import('viem');
    const publicClient = createPublicClient({
      transport: http(alchemyApiKey),
      chain: base,
    });

    // Call the contract to read the value
    const result = await publicClient.call({
      to: contractAddress as `0x${string}`,
      data: data as `0x${string}`,
    });

    console.log('Raw result from contract:', result);

    // Return the raw result data
    if (result.data) {
      console.log('Contract read successful, data:', result.data);
      return result.data;
    } else {
      throw new Error('No data returned from contract');
    }
  }

  private async calculateTokenAmounts(
    poolConfig: PoolConfig,
    usdcAmount: number,
  ): Promise<TokenAmounts> {
    console.log('=== Calculating Token Amounts ===');
    console.log('Pool Config:', poolConfig);
    console.log('USDC Amount:', usdcAmount);

    // Step 1: Calculate prices of the two tokens
    console.log('Step 1: Getting token prices...');

    let token0Price: number;
    let token1Price: number;

    // Get token prices using getTokenPriceForSwap which has comprehensive fallback logic
    if (poolConfig.token0 === this.USDC_ADDRESS) {
      token0Price = 1.0; // USDC price is always $1.00
      console.log('Token0 is USDC, price: $1.00');
    } else {
      token0Price = await this.getTokenPriceForSwap(
        poolConfig.token0,
        poolConfig.token0Name,
        poolConfig.token0Decimals,
      );
    }

    if (poolConfig.token1 === this.USDC_ADDRESS) {
      token1Price = 1.0; // USDC price is always $1.00
      console.log('Token1 is USDC, price: $1.00');
    } else {
      token1Price = await this.getTokenPriceForSwap(
        poolConfig.token1,
        poolConfig.token1Name,
        poolConfig.token1Decimals,
      );
    }

    console.log('Token prices:', {
      token0: token0Price,
      token1: token1Price,
    });

    // Step 2: Calculate token amounts for a 50/50 value split using the full USDC amount
    // Each token gets half the value in USDC, but the calculation is based on the full usdcAmount
    const token0Amount = usdcAmount / token0Price;
    const token1Amount = usdcAmount / token1Price;

    console.log('Calculated token amounts:', {
      token0: token0Amount,
      token1: token1Amount,
    });

    // Step 3: Convert to raw amounts for smart contract
    const rawToken0Amount = this.toRawAmount(
      token0Amount,
      poolConfig.token0Decimals,
    );
    const rawToken1Amount = this.toRawAmount(
      token1Amount,
      poolConfig.token1Decimals,
    );

    console.log('Raw token amounts for smart contract:', {
      token0: rawToken0Amount.toString(),
      token1: rawToken1Amount.toString(),
      token0Decimals: poolConfig.token0Decimals,
      token1Decimals: poolConfig.token1Decimals,
    });

    return {
      token0Amount,
      token1Amount,
      token0Price,
      token1Price,
      halfUsdcAmount: usdcAmount / 2, // For reference, but not used for calculation anymore
      rawToken0Amount: rawToken0Amount.toString(),
      rawToken1Amount: rawToken1Amount.toString(),
    };
  }

  private async calculateTickRange(
    poolAddress: string,
    tickSpacing: number,
    percentDeviation: number,
    customTickLower?: number,
    customTickUpper?: number,
    assumedCurrentTick?: number,
  ): Promise<TickRange> {
    console.log('=== Calculating Tick Range ===');
    console.log('Pool Address:', poolAddress);
    console.log('Tick Spacing:', tickSpacing);
    console.log('Percent Deviation:', percentDeviation);
    console.log('Custom Ticks:', { customTickLower, customTickUpper });
    console.log('Assumed Current Tick:', assumedCurrentTick);

    // Constants for tick math
    const LOG_BASE = Math.log(1.0001);

    try {
      let sqrtPriceX96: bigint;
      let tickCurrent: number;

      // Use assumed current tick if provided, otherwise fetch from pool
      if (assumedCurrentTick !== undefined) {
        console.log('Using assumed current tick:', assumedCurrentTick);
        tickCurrent = assumedCurrentTick;

        // Calculate sqrtPriceX96 from the assumed tick
        const assumedPrice = Math.exp(assumedCurrentTick * LOG_BASE);
        const sqrtPrice = Math.sqrt(assumedPrice);
        sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * 2 ** 96));

        console.log('Calculated from assumed tick:', {
          assumedTick: assumedCurrentTick,
          assumedPrice,
          sqrtPrice,
          sqrtPriceX96: sqrtPriceX96.toString(),
        });
      } else {
        // Fetch slot0 from the pool
        const slot0Result = await this.readContract(
          poolAddress,
          poolAbi as unknown as any[],
          'slot0',
          [],
        );

        console.log('Raw slot0 result:', slot0Result);

        // Decode the slot0 result
        // slot0 returns: [sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, unlocked]
        const decodedResult = this.decodeSlot0Result(slot0Result);

        sqrtPriceX96 = decodedResult.sqrtPriceX96;
        tickCurrent = decodedResult.tick;
      }

      console.log('Decoded slot0:', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        tickCurrent,
      });

      // 1. Convert sqrtPriceX96 to current price (token1/token0)
      const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
      const currentPrice = sqrtPrice ** 2;

      console.log('Price calculations:', {
        sqrtPrice,
        currentPrice,
      });

      let tickLower: number;
      let tickUpper: number;
      let lowerPrice: number;
      let upperPrice: number;

      // Check if we have custom tick range (for optimal rebalancing)
      if (customTickLower !== undefined && customTickUpper !== undefined) {
        console.log('Using custom tick range for optimal rebalancing');
        tickLower = customTickLower;
        tickUpper = customTickUpper;

        // Calculate corresponding prices for the custom ticks
        lowerPrice = Math.exp(tickLower * LOG_BASE);
        upperPrice = Math.exp(tickUpper * LOG_BASE);

        console.log('Custom tick range:', {
          tickLower,
          tickUpper,
          lowerPrice,
          upperPrice,
        });
      } else {
        // 2. Calculate lower and upper price bounds for ±N%
        const percent = percentDeviation / 100;
        lowerPrice = currentPrice * (1 - percent);
        upperPrice = currentPrice * (1 + percent);

        console.log('Price bounds:', {
          lowerPrice,
          upperPrice,
          percentDeviation: `${percentDeviation}%`,
        });

        // 3. Convert price bounds to ticks
        const tickLowerRaw = Math.floor(Math.log(lowerPrice) / LOG_BASE);
        const tickUpperRaw = Math.floor(Math.log(upperPrice) / LOG_BASE);

        // 4. Round ticks to the nearest valid tick based on tick spacing
        tickLower = Math.round(tickLowerRaw / tickSpacing) * tickSpacing;
        tickUpper = Math.round(tickUpperRaw / tickSpacing) * tickSpacing;
      }

      console.log('Raw calculated ticks:', {
        tickLower,
        tickUpper,
      });

      // 5. VALIDATION: Ensure current tick is within the calculated range
      if (tickCurrent < tickLower || tickCurrent > tickUpper) {
        console.warn(
          '⚠️ Current tick is outside calculated range! Adjusting range...',
        );
        console.warn('Before adjustment:', {
          tickCurrent,
          tickLower,
          tickUpper,
          range: tickUpper - tickLower,
        });

        // Calculate the minimum range needed to include current tick
        const rangeWidth = tickUpper - tickLower;

        // Adjust range to ensure current tick is included while respecting tick spacing
        if (tickCurrent < tickLower) {
          // Current tick is below range, shift range down
          // Round to nearest valid tick based on tick spacing
          const newTickLower =
            Math.round(tickCurrent / tickSpacing) * tickSpacing;
          const newTickUpper = newTickLower + rangeWidth;
          tickLower = newTickLower;
          tickUpper = newTickUpper;
        } else if (tickCurrent > tickUpper) {
          // Current tick is above range, shift range up
          // Round to nearest valid tick based on tick spacing
          const newTickUpper =
            Math.round(tickCurrent / tickSpacing) * tickSpacing;
          const newTickLower = newTickUpper - rangeWidth;
          tickUpper = newTickUpper;
          tickLower = newTickLower;
        }

        // Recalculate prices for the adjusted ticks
        lowerPrice = Math.exp(tickLower * LOG_BASE);
        upperPrice = Math.exp(tickUpper * LOG_BASE);

        console.warn('After adjustment:', {
          tickCurrent,
          tickLower,
          tickUpper,
          range: tickUpper - tickLower,
          lowerPrice,
          upperPrice,
        });
      }

      console.log('Final ticks (with validation):', {
        tickCurrent,
        tickLower,
        tickUpper,
        tickSpacing,
        isCurrentInRange: tickCurrent >= tickLower && tickCurrent <= tickUpper,
      });

      return {
        tickCurrent,
        tickLower,
        tickUpper,
        currentPrice,
        lowerPrice,
        upperPrice,
        sqrtPriceX96: sqrtPriceX96.toString(),
        tickSpacing,
      };
    } catch (error) {
      console.error('Error calculating tick range:', error);
      throw new Error(`Failed to calculate tick range: ${error.message}`);
    }
  }

  private decodeSlot0Result(rawData: string) {
    console.log('Decoding slot0 result:', rawData);

    // Remove '0x' prefix if present
    const data = rawData.startsWith('0x') ? rawData.slice(2) : rawData;

    // slot0 returns 6 values, each 32 bytes (64 hex chars)
    // [sqrtPriceX96 (uint160), tick (int24), ...]
    const sqrtPriceX96Hex = data.slice(0, 64);
    const tickSlotHex = data.slice(64, 128); // 32 bytes for tick slot
    const tickHex = tickSlotHex.slice(58, 64); // last 3 bytes (6 hex chars)

    const sqrtPriceX96 = BigInt('0x' + sqrtPriceX96Hex);
    const tick = decodeInt24(tickHex);

    console.log('Decoded values:', {
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick,
    });

    return {
      sqrtPriceX96,
      tick,
    };
  }

  private async calculateLiquidityAmounts(
    poolConfig: PoolConfig,
    tokenAmounts: TokenAmounts,
    tickRange: TickRange,
  ): Promise<LiquidityAmounts> {
    console.log('=== Calculating Liquidity Amounts ===');

    try {
      // Convert tick range to sqrt ratios
      const sqrtLowerX96 = BigInt(
        await this.readContract(
          this.TICKMATH_ADDRESS,
          TickMathAbi as unknown as any[],
          'getSqrtRatioAtTick',
          [tickRange.tickLower.toString()],
        ),
      );

      const sqrtUpperX96 = BigInt(
        await this.readContract(
          this.TICKMATH_ADDRESS,
          TickMathAbi as unknown as any[],
          'getSqrtRatioAtTick',
          [tickRange.tickUpper.toString()],
        ),
      );

      const rawAmount0 = BigInt(tokenAmounts.rawToken0Amount);
      const rawAmount1 = BigInt(tokenAmounts.rawToken1Amount);

      console.log('Raw token amounts:', {
        token0: rawAmount0.toString(),
        token1: rawAmount1.toString(),
      });

      // 1. Calculate liquidity for token0
      const liquidityForAmount0 = BigInt(
        await this.readContract(
          this.LIQUIDITY_AMOUNTS_ADDRESS,
          LiquidityAmountsAbi as unknown as any[],
          'getLiquidityForAmount0',
          [
            sqrtLowerX96.toString(),
            sqrtUpperX96.toString(),
            rawAmount0.toString(),
          ],
        ),
      );

      // 2. Calculate liquidity for token1
      const liquidityForAmount1 = BigInt(
        await this.readContract(
          this.LIQUIDITY_AMOUNTS_ADDRESS,
          LiquidityAmountsAbi as unknown as any[],
          'getLiquidityForAmount1',
          [
            sqrtLowerX96.toString(),
            sqrtUpperX96.toString(),
            rawAmount1.toString(),
          ],
        ),
      );

      console.log('Liquidity values:', {
        token0: liquidityForAmount0.toString(),
        token1: liquidityForAmount1.toString(),
      });

      // 3. Compare and pick the higher one
      const useToken0 = liquidityForAmount0 > liquidityForAmount1;
      const finalLiquidity = useToken0
        ? liquidityForAmount0
        : liquidityForAmount1;
      const limitingToken = useToken0 ? poolConfig.token0 : poolConfig.token1;

      console.log('Final liquidity (higher):', finalLiquidity.toString());
      console.log('Limiting token (higher):', limitingToken);

      // 4. Get the final token0 and token1 raw amounts using getAmountsForLiquidity
      const amountsRaw = await this.readContract(
        this.LIQUIDITY_AMOUNTS_ADDRESS,
        LiquidityAmountsAbi as unknown as any[],
        'getAmountsForLiquidity',
        [
          tickRange.sqrtPriceX96, // sqrtRatioX96 (current sqrt price)
          sqrtLowerX96.toString(), // sqrtRatioAX96
          sqrtUpperX96.toString(), // sqrtRatioBX96
          finalLiquidity.toString(), // liquidity
        ],
      );

      // Decode the result (two uint256 values, each 32 bytes)
      const data = amountsRaw.startsWith('0x')
        ? amountsRaw.slice(2)
        : amountsRaw;
      const amount0 = BigInt('0x' + data.slice(0, 64));
      const amount1 = BigInt('0x' + data.slice(64, 128));

      console.log('Final used raw token amounts:', {
        token0: amount0.toString(),
        token1: amount1.toString(),
      });

      return {
        finalLiquidity: finalLiquidity.toString(),
        limitingToken,
        usedAmounts: {
          token0: {
            symbol: poolConfig.token0,
            amount: Number(amount0),
            rawAmount: amount0.toString(),
          },
          token1: {
            symbol: poolConfig.token1,
            amount: Number(amount1),
            rawAmount: amount1.toString(),
          },
        },
        originalAmounts: {
          token0: {
            symbol: poolConfig.token0,
            amount: tokenAmounts.token0Amount,
            rawAmount: tokenAmounts.rawToken0Amount,
          },
          token1: {
            symbol: poolConfig.token1,
            amount: tokenAmounts.token1Amount,
            rawAmount: tokenAmounts.rawToken1Amount,
          },
        },
      };
    } catch (error: any) {
      console.error('Error calculating liquidity amounts:', error);
      throw new Error(
        `Failed to calculate liquidity amounts: ${error.message}`,
      );
    }
  }

  private decodeAmountsForLiquidityResult(rawData: string): {
    amount0: bigint;
    amount1: bigint;
  } {
    console.log('Decoding amounts for liquidity result:', rawData);

    // Remove '0x' prefix if present
    const data = rawData.startsWith('0x') ? rawData.slice(2) : rawData;

    // The function returns two uint256 values, each 32 bytes (64 hex chars)
    const amount0Hex = data.slice(0, 64);
    const amount1Hex = data.slice(64, 128);

    // Convert hex to bigint
    const amount0 = BigInt('0x' + amount0Hex);
    const amount1 = BigInt('0x' + amount1Hex);

    console.log('Decoded amounts:', {
      amount0: amount0.toString(),
      amount1: amount1.toString(),
    });

    return {
      amount0,
      amount1,
    };
  }
  async burn(
    walletLocator: string,
    tokenId: string,
    isRebalance: boolean = false,
  ) {
    try {
      // Check if wallet is currently rebalancing (only for normal burns, not rebalance burns)
      if (!isRebalance) {
        const isRebalancing = await this.isWalletRebalancing(walletLocator);
        if (isRebalancing) {
          throw new HttpException(
            `Wallet ${walletLocator} is currently undergoing rebalancing. Please try again later.`,
            409,
          );
        }
      }

      // 1. Get the position to find the full liquidity amount
      const position = await this.aerodromePositionModel.findOne({
        'metadata.mintDetails.tokenId': tokenId.toString(),
      });
      if (!position) {
        throw new HttpException('Position not found', 404);
      }
      const poolConfig = getPoolConfig(position.pool);
      if (!poolConfig) {
        throw new HttpException('Pool config not found', 404);
      }
      const walletAddress = this.getWalletAddressFromLocator(walletLocator);

      // Note collectedFees before
      const prevCollectedFees = position.collectedFees || {
        token0: '0',
        token1: '0',
      };
      const prevCollected0 = BigInt(prevCollectedFees.token0 || '0');
      const prevCollected1 = BigInt(prevCollectedFees.token1 || '0');

      console.log('=== BURN FUNCTION: Initial State Analysis ===');
      console.log('Token ID:', tokenId);
      console.log('Wallet Locator:', walletLocator);
      console.log('Is Rebalance:', isRebalance);
      console.log('Pool:', position.pool);
      console.log('Previous Collected Fees:', {
        token0: prevCollected0.toString(),
        token1: prevCollected1.toString(),
        token0Human: (
          Number(prevCollected0) / Math.pow(10, poolConfig.token0Decimals)
        ).toFixed(6),
        token1Human: (
          Number(prevCollected1) / Math.pow(10, poolConfig.token1Decimals)
        ).toFixed(6),
      });

      // 6. Get token0 and token1 balances before collecting fees (for accounting)
      console.log('=== BURN FUNCTION: Pre-Collect Balance Check ===');
      console.log('Wallet Address:', walletAddress);
      console.log('Token0 Address:', poolConfig.token0);
      console.log('Token1 Address:', poolConfig.token1);

      const token0BalanceBeforeRaw = await this.readContract(
        poolConfig.token0,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token1BalanceBeforeRaw = await this.readContract(
        poolConfig.token1,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token0BalanceBefore = BigInt(token0BalanceBeforeRaw);
      const token1BalanceBefore = BigInt(token1BalanceBeforeRaw);

      console.log('Balances before collect:', {
        token0: {
          raw: token0BalanceBefore.toString(),
          human: (
            Number(token0BalanceBefore) /
            Math.pow(10, poolConfig.token0Decimals)
          ).toFixed(6),
        },
        token1: {
          raw: token1BalanceBefore.toString(),
          human: (
            Number(token1BalanceBefore) /
            Math.pow(10, poolConfig.token1Decimals)
          ).toFixed(6),
        },
      });

      // Variables to track operations
      let decreaseLiquidityTx = null;
      let collectFeesTx = null;
      let totalCollectedToken0 = 0n;
      let totalCollectedToken1 = 0n;
      let iterationCount = 0;
      const maxIterations = 5; // Safety limit

      // Loop until both liquidity and tokensOwed are 0
      while (iterationCount < maxIterations) {
        iterationCount++;
        console.log(`=== BURN FUNCTION: Iteration ${iterationCount} ===`);

        // Get current position state on-chain
        const onChainPositionRaw = await this.readContract(
          this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
          NonFungiblePositionManagerAbi as unknown as any[],
          'positions',
          [tokenId],
        );
        const { decodeFunctionResult } = await import('viem');
        const decoded = decodeFunctionResult({
          abi: NonFungiblePositionManagerAbi as any,
          functionName: 'positions',
          data: onChainPositionRaw,
        });
        const liquidity = BigInt(decoded[7]);
        const tokensOwed0 = BigInt(decoded[10]);
        const tokensOwed1 = BigInt(decoded[11]);

        console.log('=== BURN FUNCTION: Position State Check ===');
        console.log('On-chain Liquidity:', liquidity.toString());
        console.log('On-chain TokensOwed0:', tokensOwed0.toString());
        console.log('On-chain TokensOwed1:', tokensOwed1.toString());
        console.log('Liquidity is zero:', liquidity === 0n);
        console.log(
          'TokensOwed are zero:',
          tokensOwed0 === 0n && tokensOwed1 === 0n,
        );

        // Check if we can proceed to burn (both liquidity and tokensOwed must be 0)
        if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
          console.log(
            '✅ Position ready for burn - both liquidity and tokensOwed are 0',
          );
          break;
        }

        // If liquidity is 0 but there are tokensOwed, collect fees
        if (liquidity === 0n && (tokensOwed0 > 0n || tokensOwed1 > 0n)) {
          console.log(
            '=== BURN FUNCTION: Collecting Fees (liquidity=0, tokensOwed>0) ===',
          );

          let collectFeesResult = null;
          let collectRetryCount = 0;
          const maxCollectRetries = 3;

          while (collectRetryCount < maxCollectRetries) {
            try {
              collectFeesResult = await this.collectFees(
                walletLocator,
                tokenId,
                true,
              );

              if (collectFeesResult && collectFeesResult.transactionHash) {
                break; // Success, exit retry loop
              }
            } catch (error) {
              collectRetryCount++;
              console.log(
                `Collect fees attempt ${collectRetryCount} failed:`,
                error.message,
              );

              if (collectRetryCount >= maxCollectRetries) {
                throw new Error(
                  `CollectFees transaction failed after ${maxCollectRetries} attempts. Last error: ${error.message}`,
                );
              }

              // Wait before retry (exponential backoff)
              const waitTime = Math.min(
                2000 * Math.pow(2, collectRetryCount - 1),
                10000,
              );
              console.log(`Retrying collect fees in ${waitTime}ms...`);
              await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
          }

          if (!collectFeesResult || !collectFeesResult.transactionHash) {
            throw new Error(
              `CollectFees transaction failed. Result: ${JSON.stringify(collectFeesResult)}`,
            );
          }

          collectFeesTx = collectFeesResult.transactionHash;
          console.log('✅ CollectFees transaction succeeded:', {
            transactionHash: collectFeesResult.transactionHash,
            collectedAmounts: collectFeesResult?.collected,
            attempts: collectRetryCount + 1,
          });

          // Add to total collected amounts
          const collectedFromEvent = collectFeesResult?.collected || {
            token0: '0',
            token1: '0',
          };
          totalCollectedToken0 += BigInt(collectedFromEvent.token0);
          totalCollectedToken1 += BigInt(collectedFromEvent.token1);

          console.log('Total collected so far:', {
            token0: totalCollectedToken0.toString(),
            token1: totalCollectedToken1.toString(),
          });

          // Wait a bit before next iteration to allow blockchain state to update
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // If liquidity > 0, decrease liquidity first, then collect
        if (liquidity > 0n) {
          console.log('=== BURN FUNCTION: Decreasing Liquidity ===');
          console.log('Decreasing liquidity by:', liquidity.toString());

          const decreaseParams = {
            tokenId: BigInt(tokenId),
            liquidity: BigInt(liquidity),
            amount0Min: 0,
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 1800,
          };
          console.log('Decrease params:', {
            tokenId: decreaseParams.tokenId.toString(),
            liquidity: decreaseParams.liquidity.toString(),
            deadline: new Date(decreaseParams.deadline * 1000).toISOString(),
          });

          const decreaseResult = await this.sendTransaction(
            walletLocator,
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'decreaseLiquidity',
            [decreaseParams],
          );

          if (!decreaseResult || !decreaseResult.transactionHash) {
            throw new Error(
              `DecreaseLiquidity transaction failed. Result: ${JSON.stringify(decreaseResult)}`,
            );
          }

          decreaseLiquidityTx = decreaseResult.transactionHash;
          console.log('✅ DecreaseLiquidity transaction succeeded:', {
            transactionHash: decreaseResult.transactionHash,
            status: decreaseResult.status,
          });

          // Wait a bit before collecting fees
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Now collect fees after decreasing liquidity with retry logic
          console.log('=== BURN FUNCTION: Collecting Fees After Decrease ===');

          let collectFeesResult = null;
          let collectRetryCount = 0;
          const maxCollectRetries = 3;

          while (collectRetryCount < maxCollectRetries) {
            try {
              collectFeesResult = await this.collectFees(
                walletLocator,
                tokenId,
                true,
              );

              if (collectFeesResult && collectFeesResult.transactionHash) {
                break; // Success, exit retry loop
              }
            } catch (error) {
              collectRetryCount++;
              console.log(
                `Collect fees attempt ${collectRetryCount} failed:`,
                error.message,
              );

              if (collectRetryCount >= maxCollectRetries) {
                throw new Error(
                  `CollectFees transaction failed after ${maxCollectRetries} attempts. Last error: ${error.message}`,
                );
              }

              // Wait before retry (exponential backoff)
              const waitTime = Math.min(
                2000 * Math.pow(2, collectRetryCount - 1),
                10000,
              );
              console.log(`Retrying collect fees in ${waitTime}ms...`);
              await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
          }

          if (!collectFeesResult || !collectFeesResult.transactionHash) {
            throw new Error(
              `CollectFees transaction failed. Result: ${JSON.stringify(collectFeesResult)}`,
            );
          }

          collectFeesTx = collectFeesResult.transactionHash;
          console.log('✅ CollectFees transaction succeeded:', {
            transactionHash: collectFeesResult.transactionHash,
            collectedAmounts: collectFeesResult?.collected,
          });

          // Add to total collected amounts
          const collectedFromEvent = collectFeesResult?.collected || {
            token0: '0',
            token1: '0',
          };
          totalCollectedToken0 += BigInt(collectedFromEvent.token0);
          totalCollectedToken1 += BigInt(collectedFromEvent.token1);

          console.log('Total collected so far:', {
            token0: totalCollectedToken0.toString(),
            token1: totalCollectedToken1.toString(),
          });

          // Wait a bit before next iteration
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }

        // If we reach here, something unexpected happened
        console.log('Unexpected state - liquidity and tokensOwed check failed');
        break;
      }

      if (iterationCount >= maxIterations) {
        throw new Error(
          `Burn operation exceeded maximum iterations (${maxIterations}). Position may be in an unexpected state.`,
        );
      }

      // 5. Burn the NFT (only when both liquidity and tokensOwed are 0)
      console.log('=== BURN FUNCTION: Burning NFT ===');
      console.log('Burning NFT with tokenId:', tokenId);

      // Final state verification before burn
      console.log('=== BURN FUNCTION: Final State Verification ===');
      const finalPositionState = await this.readContract(
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'positions',
        [tokenId],
      );
      const { decodeFunctionResult } = await import('viem');
      const finalDecoded = decodeFunctionResult({
        abi: NonFungiblePositionManagerAbi as any,
        functionName: 'positions',
        data: finalPositionState,
      });
      console.log('Final position state before burn:', {
        liquidity: finalDecoded[7].toString(),
        tokensOwed0: finalDecoded[10].toString(),
        tokensOwed1: finalDecoded[11].toString(),
        canBurn:
          finalDecoded[7] === 0n &&
          finalDecoded[10] === 0n &&
          finalDecoded[11] === 0n,
      });

      let burnResult = null;
      let burnRetryCount = 0;
      const maxBurnRetries = 3;

      while (burnRetryCount < maxBurnRetries) {
        try {
          burnResult = await this.sendTransaction(
            walletLocator,
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'burn',
            [tokenId],
          );

          if (burnResult && burnResult.transactionHash) {
            break; // Success, exit retry loop
          }
        } catch (error) {
          burnRetryCount++;
          console.log(`Burn attempt ${burnRetryCount} failed:`, error.message);

          if (burnRetryCount >= maxBurnRetries) {
            throw new Error(
              `Burn transaction failed after ${maxBurnRetries} attempts. Last error: ${error.message}`,
            );
          }

          // Wait before retry (exponential backoff)
          const waitTime = Math.min(
            3000 * Math.pow(2, burnRetryCount - 1),
            15000,
          );
          console.log(`Retrying burn in ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }

      // Validate that burn transaction succeeded
      if (!burnResult || !burnResult.transactionHash) {
        throw new Error(
          `Burn transaction failed. Result: ${JSON.stringify(burnResult)}`,
        );
      }

      console.log('✅ Burn transaction succeeded:', {
        transactionHash: burnResult.transactionHash,
        success: !!burnResult?.transactionHash,
        attempts: burnRetryCount + 1,
      });

      // Use the total collected amounts from our loop
      const actualReceivedToken0 = totalCollectedToken0;
      const actualReceivedToken1 = totalCollectedToken1;

      console.log('=== BURN FUNCTION: Collect Event Analysis ===');
      console.log('Total amounts collected during burn process:', {
        token0: {
          raw: actualReceivedToken0.toString(),
          human: (
            Number(actualReceivedToken0) /
            Math.pow(10, poolConfig.token0Decimals)
          ).toFixed(6),
        },
        token1: {
          raw: actualReceivedToken1.toString(),
          human: (
            Number(actualReceivedToken1) /
            Math.pow(10, poolConfig.token1Decimals)
          ).toFixed(6),
        },
      });

      // === ACCOUNTING BREAKDOWN ===
      // 1. Withdrawn amount (from collect function): actualReceivedToken0/1
      // 2. Unused amount (from metadata.mintDetails): amount0Unused/amount1Unused
      // 3. Previous fees collected (from collectedFees): prevCollected0/prevCollected1
      // Total Available = Previous Collected Fees + Current Collect + Unused Amounts

      // Add unused amounts from previous mint (if any)
      const prevMintDetails = position.metadata?.mintDetails;
      const amount0Unused = prevMintDetails?.amount0Unused
        ? BigInt(prevMintDetails.amount0Unused)
        : 0n;
      const amount1Unused = prevMintDetails?.amount1Unused
        ? BigInt(prevMintDetails.amount1Unused)
        : 0n;

      // Calculate total available: previous collected fees + actual received from collect + unused amounts
      let totalAvailableToken0;
      let totalAvailableToken1;

      // Check if balance before liquidation includes previous collected fees and unused amounts
      if (token0BalanceBefore > prevCollected0 + amount0Unused) {
        totalAvailableToken0 =
          prevCollected0 + actualReceivedToken0 + amount0Unused;
      } else {
        totalAvailableToken0 = actualReceivedToken0 + token0BalanceBefore;
      }

      if (token1BalanceBefore > prevCollected1 + amount1Unused) {
        totalAvailableToken1 =
          prevCollected1 + actualReceivedToken1 + amount1Unused;
      } else {
        totalAvailableToken1 = actualReceivedToken1 + token1BalanceBefore;
      }

      console.log('Fund calculation breakdown:', {
        balanceCheck: {
          token0: {
            balanceBefore: {
              raw: token0BalanceBefore.toString(),
              human: (
                Number(token0BalanceBefore) /
                Math.pow(10, poolConfig.token0Decimals)
              ).toFixed(6),
            },
            expectedInBalance: {
              raw: (prevCollected0 + amount0Unused).toString(),
              human: (
                Number(prevCollected0 + amount0Unused) /
                Math.pow(10, poolConfig.token0Decimals)
              ).toFixed(6),
            },
            balanceCheckPassed:
              token0BalanceBefore > prevCollected0 + amount0Unused,
          },
          token1: {
            balanceBefore: {
              raw: token1BalanceBefore.toString(),
              human: (
                Number(token1BalanceBefore) /
                Math.pow(10, poolConfig.token1Decimals)
              ).toFixed(6),
            },
            expectedInBalance: {
              raw: (prevCollected1 + amount1Unused).toString(),
              human: (
                Number(prevCollected1 + amount1Unused) /
                Math.pow(10, poolConfig.token1Decimals)
              ).toFixed(6),
            },
            balanceCheckPassed:
              token1BalanceBefore > prevCollected1 + amount1Unused,
          },
        },
        previousCollected: {
          token0: {
            raw: prevCollected0.toString(),
            human: (
              Number(prevCollected0) / Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
          },
          token1: {
            raw: prevCollected1.toString(),
            human: (
              Number(prevCollected1) / Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
          },
        },
        currentCollectReceived: {
          token0: {
            raw: actualReceivedToken0.toString(),
            human: (
              Number(actualReceivedToken0) /
              Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
          },
          token1: {
            raw: actualReceivedToken1.toString(),
            human: (
              Number(actualReceivedToken1) /
              Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
          },
        },
        unusedFromPreviousMint: {
          token0: {
            raw: amount0Unused.toString(),
            human: (
              Number(amount0Unused) / Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
          },
          token1: {
            raw: amount1Unused.toString(),
            human: (
              Number(amount1Unused) / Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
          },
        },
        totalAvailable: {
          token0: {
            raw: totalAvailableToken0.toString(),
            human: (
              Number(totalAvailableToken0) /
              Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
            calculationMethod:
              token0BalanceBefore > prevCollected0 + amount0Unused
                ? 'standard (prevCollected + currentCollect + unused)'
                : 'fallback (currentCollect + balanceBefore)',
          },
          token1: {
            raw: totalAvailableToken1.toString(),
            human: (
              Number(totalAvailableToken1) /
              Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
            calculationMethod:
              token1BalanceBefore > prevCollected1 + amount1Unused
                ? 'standard (prevCollected + currentCollect + unused)'
                : 'fallback (currentCollect + balanceBefore)',
          },
        },
      });
      console.log('Total available after burn (with balance check logic):', {
        totalAvailableToken0: totalAvailableToken0.toString(),
        totalAvailableToken1: totalAvailableToken1.toString(),
        collectReceivedToken0: actualReceivedToken0.toString(),
        collectReceivedToken1: actualReceivedToken1.toString(),
        amount0Unused: amount0Unused.toString(),
        amount1Unused: amount1Unused.toString(),
        balanceCheckResults: {
          token0: {
            balanceBefore: token0BalanceBefore.toString(),
            expectedInBalance: (prevCollected0 + amount0Unused).toString(),
            checkPassed: token0BalanceBefore > prevCollected0 + amount0Unused,
          },
          token1: {
            balanceBefore: token1BalanceBefore.toString(),
            expectedInBalance: (prevCollected1 + amount1Unused).toString(),
            checkPassed: token1BalanceBefore > prevCollected1 + amount1Unused,
          },
        },
      });

      // === Handle token amounts based on whether this is a rebalance or normal burn ===

      let withdrawAmountFinal = 0;
      let tokenAmountsForRebalance = null;

      // Calculate detailed breakdown for better understanding
      let withdrawAmountUSD = 0;
      let feesCollectedUSD = 0;
      let totalWithdrawnValueUSD = 0;
      let liquidatedAmountUSD = 0;
      let withdrawAmountTokens = { token0: '0', token1: '0' };
      let feesCollectedTokens = { token0: '0', token1: '0' };

      console.log('=== BURN FUNCTION: Mode Decision ===');
      console.log('Burn mode:', isRebalance ? 'REBALANCE' : 'NORMAL');
      console.log(
        'Decision logic:',
        isRebalance
          ? 'Store token amounts for rebalancing'
          : 'Swap tokens to USDC',
      );
      if (isRebalance) {
        // For rebalance: Store token amounts instead of swapping to USDC
        console.log(
          '=== REBALANCE MODE: Storing token amounts instead of swapping ===',
        );

        // For rebalance: Use total available amounts (previous collected + current collect + unused)
        const rebalanceToken0Amount = totalAvailableToken0;
        const rebalanceToken1Amount = totalAvailableToken1;

        console.log('=== REBALANCE MODE: Amount Calculation Logic ===');
        console.log('Rebalance calculation inputs:', {
          totalAvailableToken0: totalAvailableToken0.toString(),
          actualReceivedToken0: actualReceivedToken0.toString(),
          totalAvailableToken1: totalAvailableToken1.toString(),
          actualReceivedToken1: actualReceivedToken1.toString(),
        });

        console.log('Rebalance amount calculation:', {
          token0Logic: {
            totalAvailable: totalAvailableToken0.toString(),
            result: rebalanceToken0Amount.toString(),
          },
          token1Logic: {
            totalAvailable: totalAvailableToken1.toString(),
            result: rebalanceToken1Amount.toString(),
          },
        });

        console.log('Rebalance token amounts:', {
          rebalanceToken0Amount: rebalanceToken0Amount.toString(),
          rebalanceToken1Amount: rebalanceToken1Amount.toString(),
          totalAvailableToken0: totalAvailableToken0.toString(),
          totalAvailableToken1: totalAvailableToken1.toString(),
          actualReceivedToken0: actualReceivedToken0.toString(),
          actualReceivedToken1: actualReceivedToken1.toString(),
        });

        // Get token prices once to avoid redundancy
        let token0Price = 1.0; // USDC is always $1
        let token1Price = 1.0; // USDC is always $1

        if (poolConfig.token0 !== this.USDC_ADDRESS) {
          try {
            token0Price = await this.getTokenPriceForSwap(
              poolConfig.token0,
              poolConfig.token0Name,
              poolConfig.token0Decimals,
            );
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token0Name}:`,
              error,
            );
            token0Price = 0;
          }
        }

        if (poolConfig.token1 !== this.USDC_ADDRESS) {
          try {
            token1Price = await this.getTokenPriceForSwap(
              poolConfig.token1,
              poolConfig.token1Name,
              poolConfig.token1Decimals,
            );
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token1Name}:`,
              error,
            );
            token1Price = 0;
          }
        }

        console.log('Token prices for rebalance:', {
          token0Price,
          token1Price,
        });

        // Calculate USD values for the stored amounts (similar to cleanupFailedMint)
        let token0USDValue = 0;
        let token1USDValue = 0;

        if (poolConfig.token0 === this.USDC_ADDRESS) {
          token0USDValue =
            Number(rebalanceToken0Amount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          token0USDValue =
            (Number(rebalanceToken0Amount) /
              Math.pow(10, poolConfig.token0Decimals)) *
            token0Price;
        }

        if (poolConfig.token1 === this.USDC_ADDRESS) {
          token1USDValue =
            Number(rebalanceToken1Amount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          token1USDValue =
            (Number(rebalanceToken1Amount) /
              Math.pow(10, poolConfig.token1Decimals)) *
            token1Price;
        }

        const totalUSDValue = token0USDValue + token1USDValue;
        withdrawAmountFinal = totalUSDValue;

        // Calculate detailed breakdown for rebalance mode
        withdrawAmountUSD = totalUSDValue;
        liquidatedAmountUSD = totalUSDValue;

        // Calculate fees collected from the position (LP fees earned)
        // Since collect call only returns principal, current collect has 0 fees
        // Fees collected = Previous collected fees (from collectedFees) + Current collect fees (0)
        let feesCollectedToken0USD = 0;
        let feesCollectedToken1USD = 0;

        // Calculate USD value of previous collected fees using already fetched prices
        if (poolConfig.token0 === this.USDC_ADDRESS) {
          feesCollectedToken0USD =
            Number(prevCollected0) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          feesCollectedToken0USD =
            (Number(prevCollected0) / Math.pow(10, poolConfig.token0Decimals)) *
            token0Price;
        }

        if (poolConfig.token1 === this.USDC_ADDRESS) {
          feesCollectedToken1USD =
            Number(prevCollected1) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          feesCollectedToken1USD =
            (Number(prevCollected1) / Math.pow(10, poolConfig.token1Decimals)) *
            token1Price;
        }

        feesCollectedUSD = feesCollectedToken0USD + feesCollectedToken1USD;
        totalWithdrawnValueUSD = totalUSDValue;

        console.log('=== REBALANCE MODE: Fees Collected Analysis ===');
        console.log('LP fees earned from position (previous collected fees):', {
          token0: {
            raw: prevCollected0.toString(),
            human: (
              Number(prevCollected0) / Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
            usdValue: feesCollectedToken0USD.toFixed(6),
          },
          token1: {
            raw: prevCollected1.toString(),
            human: (
              Number(prevCollected1) / Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
            usdValue: feesCollectedToken1USD.toFixed(6),
          },
          totalUSD: feesCollectedUSD.toFixed(6),
        });

        // Withdraw amounts are the total amounts being withdrawn (principal + fees)
        // Fees collected are just the LP fees earned (from previous collectedFees)
        withdrawAmountTokens = {
          token0: rebalanceToken0Amount.toString(),
          token1: rebalanceToken1Amount.toString(),
        };
        feesCollectedTokens = {
          token0: prevCollected0.toString(),
          token1: prevCollected1.toString(),
        };

        tokenAmountsForRebalance = {
          token0: rebalanceToken0Amount.toString(),
          token1: rebalanceToken1Amount.toString(),
          totalUSDValue: totalUSDValue,
        };

        console.log('Rebalance analysis:', {
          token0: poolConfig.token0Name,
          token1: poolConfig.token1Name,
          rebalanceToken0Amount: rebalanceToken0Amount.toString(),
          rebalanceToken1Amount: rebalanceToken1Amount.toString(),
          token0USDValue: token0USDValue.toFixed(2),
          token1USDValue: token1USDValue.toFixed(2),
          totalUSDValue: totalUSDValue.toFixed(2),
        });
      } else {
        // Normal burn: Swap tokens to USDC
        console.log('=== NORMAL BURN MODE: Swapping tokens to USDC ===');

        // For normal burn: Use total available amounts (previous collected + current collect + unused)
        console.log('=== NORMAL BURN MODE: Swap Amount Calculation ===');
        console.log('Swap calculation inputs:', {
          totalAvailableToken0: totalAvailableToken0.toString(),
          actualReceivedToken0: actualReceivedToken0.toString(),
          totalAvailableToken1: totalAvailableToken1.toString(),
          actualReceivedToken1: actualReceivedToken1.toString(),
        });

        const swapAmountToken0 = totalAvailableToken0;
        const swapAmountToken1 = totalAvailableToken1;

        console.log('Swap amount calculation:', {
          token0Logic: {
            totalAvailable: totalAvailableToken0.toString(),
            result: swapAmountToken0.toString(),
          },
          token1Logic: {
            totalAvailable: totalAvailableToken1.toString(),
            result: swapAmountToken1.toString(),
          },
        });
        let usdcFromToken0 = 0;
        let usdcFromToken1 = 0;
        if (poolConfig.token0 !== this.USDC_ADDRESS && swapAmountToken0 > 0n) {
          const { buyAmount } = await this.swapTokens(
            walletLocator,
            poolConfig.token0,
            this.USDC_ADDRESS,
            swapAmountToken0.toString(),
          );
          usdcFromToken0 = Number(buyAmount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          usdcFromToken0 =
            Number(swapAmountToken0) / Math.pow(10, poolConfig.token0Decimals);
        }
        if (poolConfig.token1 !== this.USDC_ADDRESS && swapAmountToken1 > 0n) {
          const { buyAmount } = await this.swapTokens(
            walletLocator,
            poolConfig.token1,
            this.USDC_ADDRESS,
            swapAmountToken1.toString(),
          );
          usdcFromToken1 = Number(buyAmount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          usdcFromToken1 =
            Number(swapAmountToken1) / Math.pow(10, poolConfig.token1Decimals);
        }
        console.log('USDC from token0:', usdcFromToken0);
        console.log('USDC from token1:', usdcFromToken1);

        // Calculate USD value of the liquidated amounts (collected from position)
        let liquidatedAmountUSD = 0;
        if (poolConfig.token0 === this.USDC_ADDRESS) {
          liquidatedAmountUSD +=
            Number(actualReceivedToken0) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token0Price = await this.getTokenPrice(poolConfig.token0Name);
            liquidatedAmountUSD +=
              (Number(actualReceivedToken0) /
                Math.pow(10, poolConfig.token0Decimals)) *
              token0Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token0Name}:`,
              error,
            );
          }
        }

        if (poolConfig.token1 === this.USDC_ADDRESS) {
          liquidatedAmountUSD +=
            Number(actualReceivedToken1) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token1Price = await this.getTokenPrice(poolConfig.token1Name);
            liquidatedAmountUSD +=
              (Number(actualReceivedToken1) /
                Math.pow(10, poolConfig.token1Decimals)) *
              token1Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token1Name}:`,
              error,
            );
          }
        }

        console.log('Liquidated amount in USD:', liquidatedAmountUSD);
        withdrawAmountFinal = usdcFromToken0 + usdcFromToken1;

        // Calculate detailed breakdown for normal burn mode
        withdrawAmountUSD = usdcFromToken0 + usdcFromToken1;

        // Calculate fees collected from the position (LP fees earned)
        // Since collect call only returns principal, current collect has 0 fees
        // Fees collected = Previous collected fees (from collectedFees) + Current collect fees (0)
        let feesCollectedToken0USD = 0;
        let feesCollectedToken1USD = 0;

        // Calculate USD value of previous collected fees
        if (poolConfig.token0 === this.USDC_ADDRESS) {
          feesCollectedToken0USD =
            Number(prevCollected0) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token0Price = await this.getTokenPrice(poolConfig.token0Name);
            feesCollectedToken0USD =
              (Number(prevCollected0) /
                Math.pow(10, poolConfig.token0Decimals)) *
              token0Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token0Name}:`,
              error,
            );
            feesCollectedToken0USD = 0;
          }
        }

        if (poolConfig.token1 === this.USDC_ADDRESS) {
          feesCollectedToken1USD =
            Number(prevCollected1) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token1Price = await this.getTokenPrice(poolConfig.token1Name);
            feesCollectedToken1USD =
              (Number(prevCollected1) /
                Math.pow(10, poolConfig.token1Decimals)) *
              token1Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token1Name}:`,
              error,
            );
            feesCollectedToken1USD = 0;
          }
        }

        feesCollectedUSD = feesCollectedToken0USD + feesCollectedToken1USD;
        totalWithdrawnValueUSD = withdrawAmountUSD;

        console.log('=== NORMAL BURN MODE: Fees Collected Analysis ===');
        console.log('LP fees earned from position (previous collected fees):', {
          token0: {
            raw: prevCollected0.toString(),
            human: (
              Number(prevCollected0) / Math.pow(10, poolConfig.token0Decimals)
            ).toFixed(6),
            usdValue: feesCollectedToken0USD.toFixed(6),
          },
          token1: {
            raw: prevCollected1.toString(),
            human: (
              Number(prevCollected1) / Math.pow(10, poolConfig.token1Decimals)
            ).toFixed(6),
            usdValue: feesCollectedToken1USD.toFixed(6),
          },
          totalUSD: feesCollectedUSD.toFixed(6),
        });

        // Withdraw amounts are the total amounts being withdrawn (principal + fees)
        // Fees collected are just the LP fees earned (from previous collectedFees)
        withdrawAmountTokens = {
          token0: swapAmountToken0.toString(),
          token1: swapAmountToken1.toString(),
        };
        feesCollectedTokens = {
          token0: prevCollected0.toString(),
          token1: prevCollected1.toString(),
        };
      }

      // 8. Update DB: mark position as closed/burned and store withdrawAmountFinal
      console.log('=== BURN FUNCTION: Database Update ===');
      console.log('Updating position status to "closed"');
      console.log('Detailed amounts breakdown:', {
        withdrawAmountUSD: withdrawAmountUSD.toFixed(6),
        feesCollectedUSD: feesCollectedUSD.toFixed(6),
        totalWithdrawnValueUSD: totalWithdrawnValueUSD.toFixed(6),
        withdrawAmountTokens: withdrawAmountTokens,
        feesCollectedTokens: feesCollectedTokens,
        legacyWithdrawAmountFinal: withdrawAmountFinal.toFixed(6),
      });
      console.log('Transaction hashes:', {
        decreaseLiquidity: decreaseLiquidityTx,
        burn: burnResult?.transactionHash,
        collectFees: collectFeesTx,
      });

      await this.aerodromePositionModel.findOneAndUpdate(
        { 'metadata.mintDetails.tokenId': tokenId.toString() },
        {
          status: 'closed',
          metadata: {
            ...position.metadata,
            burn: {
              decreaseLiquidityTx: decreaseLiquidityTx,
              burnTx: burnResult?.transactionHash,
              collectFeesTx: collectFeesTx,
              timestamp: new Date().toISOString(),
            },
            withdrawAmountFinal, // Keep for backward compatibility
            withdrawAmountUSD,
            feesCollectedUSD,
            totalWithdrawnValueUSD,
            liquidatedAmountUSD,
            withdrawAmountTokens,
            feesCollectedTokens,
            // === ACCOUNTING BREAKDOWN ===
            accountingBreakdown: {
              // 1. Withdrawn amount (from collect function)
              withdrawnFromCollect: {
                token0: actualReceivedToken0.toString(),
                token1: actualReceivedToken1.toString(),
              },
              // 2. Unused amount (from metadata.mintDetails)
              unusedFromMint: {
                token0: amount0Unused.toString(),
                token1: amount1Unused.toString(),
              },
              // 3. Previous fees collected (from collectedFees)
              previousCollectedFees: {
                token0: prevCollected0.toString(),
                token1: prevCollected1.toString(),
              },
              // Total calculation
              totalAvailable: {
                token0: totalAvailableToken0.toString(),
                token1: totalAvailableToken1.toString(),
              },
            },
          },
        },
      );

      console.log('Database update completed successfully');

      // 9. Return result
      const result: any = {
        message: 'Position fully closed and burned successfully',
        tokenId,
        decreaseLiquidityTx: decreaseLiquidityTx,
        burnTx: burnResult?.transactionHash,
        collectFeesTx: collectFeesTx,
        totalTokensReceived: {
          token0: (
            prevCollected0 +
            actualReceivedToken0 +
            amount0Unused
          ).toString(),
          token1: (
            prevCollected1 +
            actualReceivedToken1 +
            amount1Unused
          ).toString(),
        },
        withdrawAmountFinal, // Keep for backward compatibility
        detailedAmounts: {
          withdrawAmountUSD,
          feesCollectedUSD,
          totalWithdrawnValueUSD,
          liquidatedAmountUSD,
          withdrawAmountTokens,
          feesCollectedTokens,
        },
        balances: {
          before: {
            token0: token0BalanceBefore.toString(),
            token1: token1BalanceBefore.toString(),
          },
        },
        prevCollectedFees: {
          token0: prevCollected0.toString(),
          token1: prevCollected1.toString(),
        },
        iterations: iterationCount,
      };

      // Add token amounts for rebalance if this was a rebalance operation
      if (isRebalance && tokenAmountsForRebalance) {
        result.tokenAmountsForRebalance = tokenAmountsForRebalance;
      }

      console.log('=== BURN FUNCTION: Summary ===');
      console.log('Burn operation completed successfully');
      console.log('Mode:', isRebalance ? 'REBALANCE' : 'NORMAL');
      console.log('Iterations required:', iterationCount);
      console.log('Detailed amounts summary:', {
        withdrawAmountUSD: withdrawAmountUSD.toFixed(6),
        feesCollectedUSD: feesCollectedUSD.toFixed(6),
        totalWithdrawnValueUSD: totalWithdrawnValueUSD.toFixed(6),
        withdrawAmountTokens: withdrawAmountTokens,
        feesCollectedTokens: feesCollectedTokens,
        legacyWithdrawAmountFinal: withdrawAmountFinal.toFixed(6),
      });
      console.log('Total tokens received:', {
        token0: (
          prevCollected0 +
          actualReceivedToken0 +
          amount0Unused
        ).toString(),
        token1: (
          prevCollected1 +
          actualReceivedToken1 +
          amount1Unused
        ).toString(),
      });
      console.log('=== BURN FUNCTION: END ===');

      return result;
    } catch (error) {
      console.error('Error burning position:', error);

      // Provide more specific error messages based on the error type
      let errorMessage = error.message || 'Failed to burn position';
      let errorStatus = error.status || 500;

      if (error.message?.includes('Transaction failed or timed out')) {
        errorMessage = `Burn operation failed: Transaction timed out or failed. Please check the transaction status manually. ${error.message}`;
        errorStatus = 408; // Request Timeout
      } else if (
        error.message?.includes('DecreaseLiquidity transaction failed')
      ) {
        errorMessage = `Burn operation failed: Could not remove liquidity from position. ${error.message}`;
        errorStatus = 400;
      } else if (error.message?.includes('CollectFees transaction failed')) {
        errorMessage = `Burn operation failed: Could not collect fees from position. ${error.message}`;
        errorStatus = 400;
      } else if (error.message?.includes('Burn transaction failed')) {
        errorMessage = `Burn operation failed: Could not burn the NFT position. ${error.message}`;
        errorStatus = 400;
      } else if (error.message?.includes('exceeded maximum iterations')) {
        errorMessage = `Burn operation failed: Position may be in an unexpected state. ${error.message}`;
        errorStatus = 400;
      }

      throw new HttpException(errorMessage, errorStatus);
    }
  }
  async collectFees(
    walletLocator: string,
    tokenId: string,
    skipAprCalculation: boolean = false,
  ) {
    try {
      // Get the wallet address from locator
      const walletAddress = this.getWalletAddressFromLocator(walletLocator);
      // Use max uint128 for amount0Max and amount1Max
      const MAX_UINT128 = 2n ** 128n - 1n;
      const params = {
        tokenId: BigInt(tokenId),
        recipient: walletAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      };
      const collectResult = await this.sendTransaction(
        walletLocator,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'collect',
        [params],
      );

      // Fetch and decode the transaction receipt to get Collect event
      let collected0 = 0n,
        collected1 = 0n;
      if (collectResult?.transactionHash) {
        const alchemyApiKey = this.configService.get<string>(
          'ALCHEMY_API_KEY_BASE',
        );
        const { createPublicClient, http, decodeEventLog } = await import(
          'viem'
        );
        const publicClient = createPublicClient({
          transport: http(alchemyApiKey),
          chain: base,
        });
        const receipt = await publicClient.getTransactionReceipt({
          hash: collectResult.transactionHash as `0x${string}`,
        });

        console.log('Transaction receipt logs:', receipt.logs.length);

        for (const log of receipt.logs) {
          try {
            const event = decodeEventLog({
              abi: NonFungiblePositionManagerAbi as any,
              data: (log as any).data,
              topics: (log as any).topics,
            }) as any;
            console.log('Decoded event:', event.eventName, event.args);

            if (
              event.eventName === 'Collect' &&
              event.args?.tokenId?.toString() === tokenId.toString()
            ) {
              collected0 = BigInt(event.args.amount0);
              collected1 = BigInt(event.args.amount1);
              console.log(
                'Found Collect event for tokenId:',
                tokenId,
                'amounts:',
                collected0.toString(),
                collected1.toString(),
              );
              break;
            }
          } catch (error) {
            console.log('Failed to decode log:', error.message);
          }
        }

        console.log(
          'Final collected amounts:',
          collected0.toString(),
          collected1.toString(),
        );
      }

      // Fetch current cumulative from DB
      const position = await this.aerodromePositionModel.findOne({
        'metadata.mintDetails.tokenId': tokenId.toString(),
      });
      const prev0 = BigInt(position?.collectedFees?.token0 || '0');
      const prev1 = BigInt(position?.collectedFees?.token1 || '0');

      console.log(
        'Previous cumulative fees from DB:',
        prev0.toString(),
        prev1.toString(),
      );
      console.log(
        'Newly collected amounts:',
        collected0.toString(),
        collected1.toString(),
      );

      // Update cumulative
      const new0 = (prev0 + collected0).toString();
      const new1 = (prev1 + collected1).toString();

      console.log('New cumulative amounts to save:', new0, new1);

      // Check if actual fees were earned (either token0 or token1 increased)
      const feesActuallyEarned = collected0 > 0n || collected1 > 0n;
      console.log('Fees actually earned:', feesActuallyEarned, {
        collected0: collected0.toString(),
        collected1: collected1.toString(),
      });

      // === SHARED PRICE FETCHING AND CALCULATIONS ===
      let apr = 0;
      let totalFeesUSD = 0;
      let token0Price: number | null = null;
      let token1Price: number | null = null;
      let poolConfig: PoolConfig | null = null;

      // Get pool configuration and token prices (shared between APR and daily tracking)
      if (position && position.pool) {
        poolConfig = getPoolConfig(position.pool);
        if (poolConfig) {
          try {
            // Fetch token prices once - will be used for both APR and daily tracking
            token0Price = await this.getTokenPrice(poolConfig.token0Name);
            token1Price = await this.getTokenPrice(poolConfig.token1Name);

            console.log('Token prices fetched:', {
              token0Name: poolConfig.token0Name,
              token1Name: poolConfig.token1Name,
              token0Price,
              token1Price,
            });
          } catch (error) {
            console.error('Error fetching token prices:', error);
            // Continue without prices - both APR and daily tracking will be skipped
          }
        } else {
          console.warn(`Pool config not found for pool ${position.pool}`);
        }
      }

      // === APR CALCULATION ===
      if (
        !skipAprCalculation &&
        poolConfig &&
        token0Price !== null &&
        token1Price !== null
      ) {
        if (position.usdcAmount && (position as any).createdAt) {
          try {
            console.log('=== Calculating APR ===');

            // Convert cumulative fees to human-readable amounts
            const new0Human =
              Number(new0) / Math.pow(10, poolConfig.token0Decimals);
            const new1Human =
              Number(new1) / Math.pow(10, poolConfig.token1Decimals);

            console.log('Cumulative fees in human amounts:', {
              token0: new0Human,
              token1: new1Human,
              token0Decimals: poolConfig.token0Decimals,
              token1Decimals: poolConfig.token1Decimals,
            });

            // Calculate total fees in USD
            const token0FeesUSD = new0Human * token0Price;
            const token1FeesUSD = new1Human * token1Price;
            totalFeesUSD = token0FeesUSD + token1FeesUSD;

            console.log('Fees in USD:', {
              token0FeesUSD,
              token1FeesUSD,
              totalFeesUSD,
            });

            // Calculate time elapsed since position creation
            const createdAt = new Date((position as any).createdAt);
            const now = new Date();
            const timeElapsedMs = now.getTime() - createdAt.getTime();
            const timeElapsedYears =
              timeElapsedMs / (1000 * 60 * 60 * 24 * 365.25); // Convert to years

            console.log('Time calculation:', {
              createdAt: createdAt.toISOString(),
              now: now.toISOString(),
              timeElapsedMs,
              timeElapsedYears,
            });

            // Calculate APR: (Total Fees USD / Original Investment USD) / Time in Years
            if (timeElapsedYears > 0 && position.usdcAmount > 0) {
              apr = totalFeesUSD / position.usdcAmount / timeElapsedYears;
              apr = apr * 100; // Convert to percentage

              console.log('APR calculation:', {
                totalFeesUSD,
                originalInvestment: position.usdcAmount,
                timeElapsedYears,
                apr: `${apr.toFixed(2)}%`,
              });
            } else {
              console.log(
                'Cannot calculate APR: insufficient time elapsed or zero investment',
              );
            }
          } catch (error) {
            console.error('Error calculating APR:', error);
            // Continue with the function even if APR calculation fails
          }
        }
      }

      // Update database with new cumulative fees and APR
      const updateData: any = {
        'collectedFees.token0': new0,
        'collectedFees.token1': new1,
      };

      // Add APR and analytics to collectedFees if calculated successfully
      if (apr > 0) {
        updateData['collectedFees.apr'] = apr;
        updateData['collectedFees.lastAprUpdate'] = new Date().toISOString();
        updateData['collectedFees.totalFeesUSD'] = totalFeesUSD;
      }

      // === DAILY FEE TRACKING ===
      // Only track daily fees if this is NOT a burn operation (skipAprCalculation = true indicates burn)
      if (feesActuallyEarned && !skipAprCalculation) {
        try {
          console.log('=== Updating Daily Fee Tracking ===');

          // Get current UTC date in YYYY-MM-DD format
          const currentDate = new Date().toISOString().split('T')[0];
          console.log('Current UTC date for daily tracking:', currentDate);

          // Get or create daily fees document
          const dailyFeesDoc =
            await this.getOrCreateDailyFeesDocument(currentDate);

          // Get pool configuration for token addresses and symbols
          const poolConfig = getPoolConfig(position.pool);
          if (!poolConfig) {
            console.warn(
              `Pool config not found for pool ${position.pool}, skipping daily fee tracking`,
            );
          } else {
            // Calculate USD value of collected fees
            const token0Price = await this.getTokenPrice(poolConfig.token0Name);
            const token1Price = await this.getTokenPrice(poolConfig.token1Name);

            const token0Human =
              Number(collected0) / Math.pow(10, poolConfig.token0Decimals);
            const token1Human =
              Number(collected1) / Math.pow(10, poolConfig.token1Decimals);

            const token0UsdValue = token0Human * token0Price;
            const token1UsdValue = token1Human * token1Price;
            const totalUsdValue = token0UsdValue + token1UsdValue;

            console.log('Daily fee calculation:', {
              token0: {
                symbol: poolConfig.token0Name,
                amount: token0Human,
                usdValue: token0UsdValue,
              },
              token1: {
                symbol: poolConfig.token1Name,
                amount: token1Human,
                usdValue: token1UsdValue,
              },
              totalUsdValue,
            });

            // Update daily fees document
            const updateOperations: any = {
              $inc: {
                totalUsdValue: totalUsdValue,
                totalCollections: 1,
              },
            };

            // Add position-specific fees
            updateOperations.$set = {
              [`positionFees.${tokenId}`]: {
                token0: collected0.toString(),
                token1: collected1.toString(),
                usdValue: totalUsdValue,
                walletLocator: walletLocator,
                pool: position.pool,
                timestamp: new Date(),
              },
            };

            // Update token totals
            if (collected0 > 0n) {
              updateOperations.$inc[`tokenTotals.${poolConfig.token0}.amount`] =
                Number(collected0);
              updateOperations.$inc[
                `tokenTotals.${poolConfig.token0}.usdValue`
              ] = token0UsdValue;
              updateOperations.$set[`tokenTotals.${poolConfig.token0}.symbol`] =
                poolConfig.token0Name;
            }

            if (collected1 > 0n) {
              updateOperations.$inc[`tokenTotals.${poolConfig.token1}.amount`] =
                Number(collected1);
              updateOperations.$inc[
                `tokenTotals.${poolConfig.token1}.usdValue`
              ] = token1UsdValue;
              updateOperations.$set[`tokenTotals.${poolConfig.token1}.symbol`] =
                poolConfig.token1Name;
            }

            // Increment total positions if this is a new position for the day
            if (!dailyFeesDoc.positionFees[tokenId]) {
              updateOperations.$inc.totalPositions = 1;
            }

            // Update the daily fees document
            await this.dailyFeesModel.findOneAndUpdate(
              { date: currentDate },
              updateOperations,
              { upsert: true },
            );

            console.log('✅ Daily fee tracking updated successfully');
          }
        } catch (error) {
          console.error('Error updating daily fee tracking:', error);
          // Continue with the function even if daily tracking fails
        }
      }

      // Update lastActualEarning timestamp only if fees were actually earned
      if (feesActuallyEarned) {
        updateData['collectedFees.lastActualEarning'] =
          new Date().toISOString();
        console.log(
          '✅ Updated lastActualEarning timestamp - fees were earned',
        );
      } else {
        console.log(
          '⏸️ No fees earned - keeping existing lastActualEarning timestamp',
        );
      }

      await this.aerodromePositionModel.findOneAndUpdate(
        { 'metadata.mintDetails.tokenId': tokenId.toString() },
        {
          $set: updateData,
        },
      );

      console.log('Database updated successfully with APR:', {
        apr: apr > 0 ? `${apr.toFixed(2)}%` : 'N/A',
        totalFeesUSD,
      });

      return {
        message: 'Fees collected successfully',
        tokenId,
        transactionHash: collectResult?.transactionHash,
        collected: {
          token0: collected0.toString(),
          token1: collected1.toString(),
        },
        cumulative: { token0: new0, token1: new1 },
        collectedFees: {
          token0: new0,
          token1: new1,
          apr: apr > 0 ? apr : null,
          lastAprUpdate:
            apr > 0 ? updateData['collectedFees.lastAprUpdate'] : null,
          totalFeesUSD: totalFeesUSD > 0 ? totalFeesUSD : null,
        },
      };
    } catch (error) {
      console.error('Error collecting fees:', error);
      throw new HttpException(
        error.message || 'Failed to collect fees',
        error.status || 500,
      );
    }
  }

  // === TESTING ENDPOINTS ===
  async findActivePositionsOutOfRange(tick: number) {
    // Returns active positions where the given tick is out of their range
    const positions = await this.aerodromePositionModel.find({
      status: 'active',
    });
    return positions.filter((pos) => {
      const tickRange = pos.metadata?.tickRange;
      if (!tickRange) return false;
      return tick < tickRange.tickLower || tick > tickRange.tickUpper;
    });
  }

  async findActivePositionsOlderThan5h() {
    // Returns active positions older than 5 hours
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    return this.aerodromePositionModel.find({
      status: 'active',
      createdAt: { $lt: fiveHoursAgo },
    });
  }

  // === REBALANCING LOGIC ===
  /**
   * Public method to add a position to rebalancing queue
   */
  async rebalancePosition(
    positionId: string,
    reason: 'out_of_range' | 'fee_optimiser' | 'performance_loss',
    strategyName?: string,
  ) {
    return this.rebalancePositionInternal(positionId, reason, strategyName);
  }

  /**
   * Internal method that performs the actual rebalancing
   */
  private async rebalancePositionInternal(
    positionId: string,
    reason: 'out_of_range' | 'fee_optimiser' | 'performance_loss',
    strategyName?: string,
  ) {
    try {
      console.log(
        `=== Rebalancing Position ${positionId} (Reason: ${reason}) ===`,
      );

      // Get the position details
      const position = await this.aerodromePositionModel.findOne({
        positionId,
      });
      if (!position) {
        throw new HttpException(`Position ${positionId} not found`, 404);
      }

      // Check if position is already being rebalanced to prevent duplicates
      if (position.status === 'rebalancing') {
        console.log(
          `Position ${positionId} is already being rebalanced, skipping`,
        );
        return {
          success: false,
          message: `Position ${positionId} is already being rebalanced`,
          reason: 'already_rebalancing',
        };
      }

      if (position.status !== 'active') {
        throw new HttpException(
          `Position ${positionId} is not active (status: ${position.status})`,
          400,
        );
      }

      // Mark position as rebalancing to prevent duplicate processing
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          status: 'rebalancing',
          $set: {
            'metadata.rebalancingInfo': {
              reason,
              startedAt: new Date().toISOString(),
              isRebalancing: true,
            },
          },
        },
      );

      console.log('Position details:', {
        walletLocator: position.walletLocator,
        pool: position.pool,
        usdcAmount: position.usdcAmount,
        collectedFees: position.collectedFees,
      });

      // Step 1: Burn the old position (this will also collect any remaining fees)
      console.log('Step 1: Burning old position...');
      const tokenId = position.metadata?.mintDetails?.tokenId;

      // Validate that we have the required tokenId before proceeding
      if (!tokenId) {
        throw new HttpException(
          `Position ${positionId} missing required tokenId in metadata. Position may be corrupted or incomplete.`,
          400,
        );
      }

      const burnResult = await this.burn(position.walletLocator, tokenId, true); // Pass isRebalance=true
      console.log('Burn result:', burnResult);

      // Validate burn result before proceeding
      if (!burnResult) {
        throw new HttpException(
          `Burn operation failed for position ${positionId} - no result returned`,
          500,
        );
      }

      // Step 2: Use the token amounts from burn result for rebalancing
      const originalUsdcAmount = position.usdcAmount;
      const totalTokensReceived = burnResult.totalTokensReceived;

      // For rebalance, use the stored token amounts instead of USDC amount
      const newUsdcAmount =
        burnResult.tokenAmountsForRebalance?.totalUSDValue ||
        burnResult.withdrawAmountFinal ||
        0;

      console.log('Rebalance calculation:', {
        original: originalUsdcAmount,
        totalTokensReceived,
        newTotal: newUsdcAmount,
        tokenAmountsForRebalance: burnResult.tokenAmountsForRebalance,
      });

      // Step 4: Mint new position with updated amount
      console.log('Step 4: Minting new position...');

      // Check if we have optimal range data from fee-optimiser analysis
      const optimalRebalanceRange = position.metadata?.optimalRebalanceRange;
      let useOptimalRange = false;
      let optimalTickLower = null;
      let optimalTickUpper = null;

      if (optimalRebalanceRange && reason === 'fee_optimiser') {
        console.log(
          'Found optimal rebalance range data:',
          optimalRebalanceRange,
        );

        // Check if the optimal range analysis is recent (within last 4 hours)
        const analysisTime = new Date(optimalRebalanceRange.analysisTimestamp);
        const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);

        if (analysisTime > fourHoursAgo) {
          useOptimalRange = true;
          optimalTickLower = optimalRebalanceRange.tickLower;
          optimalTickUpper = optimalRebalanceRange.tickUpper;

          console.log('Using optimal range for rebalancing:', {
            originalRange: `${position.metadata?.tickRange?.tickLower} to ${position.metadata?.tickRange?.tickUpper}`,
            optimalRange: `${optimalTickLower} to ${optimalTickUpper}`,
            volumeCaptureImprovement: `${optimalRebalanceRange.volumeCapturePercentage.toFixed(2)}%`,
          });
        } else {
          console.log(
            'Optimal range data is too old, using default range calculation',
          );
        }
      }

      // Get percentDeviation from original position's tick range
      const originalPercentDeviation =
        position.metadata?.tickRange?.percentDeviation !== undefined
          ? position.metadata?.tickRange?.percentDeviation
          : 1.5;
      console.log('Original percent deviation:', originalPercentDeviation);
      console.log(
        'Percent deviation:',
        position.metadata?.tickRange?.percentDeviation,
      );

      // Pass strategyName to mint function to preserve strategy
      // Note: strategyName will be added to the final mintDto below

      // Store the token amounts from burn result in the original position for rebalancing
      if (burnResult.tokenAmountsForRebalance) {
        console.log(
          'Storing token amounts for rebalancing:',
          burnResult.tokenAmountsForRebalance,
        );

        await this.aerodromePositionModel.findOneAndUpdate(
          { positionId },
          {
            $set: {
              'metadata.retryMetadata': {
                originalTokenAmounts: {
                  token0: burnResult.tokenAmountsForRebalance.token0,
                  token1: burnResult.tokenAmountsForRebalance.token1,
                  totalUSDValue:
                    burnResult.tokenAmountsForRebalance.totalUSDValue,
                },
                retryAttempts: 0,
                lastRetryAt: new Date(),
                rebalanceCompletedAt: new Date().toISOString(),
              },
            },
          },
        );
      }

      // Get rebalanceRange from original position for fee-optimiser strategy (not needed for v2)
      const originalRebalanceRange = position.metadata?.rebalanceRange || 3.0;

      // Get the last positionHistory tick and calculate tick range for performance loss rebalancing
      let assumedCurrentTick: number | undefined;
      let customTickLower: number | undefined;
      let customTickUpper: number | undefined;

      if (reason === 'performance_loss') {
        const positionHistory = position.metadata?.positionHistory;
        if (positionHistory && positionHistory.length > 0) {
          const lastHistoryEntry = positionHistory[positionHistory.length - 1];
          const lastTick = lastHistoryEntry?.currentTick;

          if (lastTick !== undefined && lastTick !== null) {
            // Get pool config to get tickSpacing
            const poolConfig = getPoolConfig(position.pool);
            if (poolConfig) {
              // Snap to lower multiple of tickSpacing (always round down)
              const snappedTick =
                Math.floor(lastTick / poolConfig.tickSpacing) *
                poolConfig.tickSpacing;

              if (originalPercentDeviation === 0.5) {
                // For 0.5% positions: Shift range DOWN by one full range width to avoid current tick
                const rangeWidth = 100; // 0.5% deviation = 100 ticks
                customTickLower = snappedTick - rangeWidth; // -19800 - 100 = -19900
                customTickUpper = snappedTick; // -19800

                console.log(
                  'Using shifted tick range for 0.5% performance loss rebalancing:',
                  {
                    originalTick: lastTick,
                    tickSpacing: poolConfig.tickSpacing,
                    snappedTick,
                    customTickLower,
                    customTickUpper,
                    rangeWidth,
                    timestamp: lastHistoryEntry.timestamp,
                  },
                );
              } else {
                // For 1% positions: Use snapped tick as assumed current tick
                assumedCurrentTick = snappedTick;

                console.log(
                  'Using snapped tick for 1% performance loss rebalancing:',
                  {
                    originalTick: lastTick,
                    tickSpacing: poolConfig.tickSpacing,
                    snappedTick: assumedCurrentTick,
                    timestamp: lastHistoryEntry.timestamp,
                  },
                );
              }
            }
          }
        }
      }

      const newPositionDto = {
        walletLocator: position.walletLocator,
        pool: position.pool,
        usdcAmount: newUsdcAmount,
        description: `Rebalanced position (${reason}) - Original: ${originalUsdcAmount} USDC, New total: ${newUsdcAmount} USDC`,
        rebalancedPositionId: positionId, // Pass the original position ID being rebalanced
        percentDeviation: originalPercentDeviation, // Pass the original percentDeviation
        isRebalanceOrRetry: true, // Add flag for rebalancing flow
        positionId: positionId, // Pass the position ID to get stored token amounts
        // Add rebalanceRange only for fee-optimiser (not v2)
        ...(position.metadata?.strategyName === 'fee-optimiser' && {
          rebalanceRange: originalRebalanceRange,
        }),
        // Add optimal range data if available
        ...(useOptimalRange && {
          customTickLower: optimalTickLower,
          customTickUpper: optimalTickUpper,
        }),
        // Add custom tick range for 0.5% performance loss rebalancing
        ...(customTickLower !== undefined &&
          customTickUpper !== undefined && {
            customTickLower,
            customTickUpper,
          }),
        // Add assumed current tick for rebalancing
        ...(assumedCurrentTick !== undefined && {
          assumedCurrentTick,
        }),
      };

      console.log('Rebalance newPositionDto with percentDeviation:', {
        percentDeviation: newPositionDto.percentDeviation,
        type: typeof newPositionDto.percentDeviation,
      });

      // Create a proper DTO instance to ensure validation works correctly
      const mintDto = new CreateAerodromeLpDto();
      Object.assign(mintDto, newPositionDto);
      // Add strategyName if it exists
      if (strategyName) {
        mintDto.strategyName = strategyName;
      }

      console.log('Rebalance created DTO instance:', {
        dtoKeys: Object.keys(mintDto),
        hasPercentDeviation: 'percentDeviation' in mintDto,
        percentDeviation: mintDto.percentDeviation,
      });

      const mintResult = await this.mint(mintDto);
      console.log('Mint result:', mintResult);

      // Step 5: Update the original position record with rebalancing info and clear rebalancing flag
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          status: 'rebalanced',
          $unset: {
            'metadata.rebalancingInfo.isRebalancing': 1,
          },
          $set: {
            'metadata.rebalancingInfo.completedAt': new Date().toISOString(),
            'metadata.rebalancingInfo.success': true,
            rebalancing: {
              reason,
              timestamp: new Date().toISOString(),
              originalUsdcAmount,
              totalTokensReceived,
              newUsdcAmount,
              burnTransactionHash: burnResult?.burnTx,
              mintTransactionHash: mintResult?.details?.mint?.transactionHash,
              newPositionId: mintResult?.positionId,
            },
          },
        },
      );

      // Process next position in queue for this wallet
      await this.processNextInQueue(position.walletLocator);

      return {
        success: true,
        message: `Position ${positionId} rebalanced successfully`,
        originalPositionId: positionId,
        newPositionId: mintResult?.positionId,
        originalUsdcAmount,
        totalTokensReceived,
        newUsdcAmount,
        burnResult,
        mintResult,
      };
    } catch (error) {
      console.error(`Error rebalancing position ${positionId}:`, error);

      // Update position status to failed and clear rebalancing flag
      try {
        await this.aerodromePositionModel.findOneAndUpdate(
          { positionId },
          {
            status: 'rebalance_failed',
            $unset: {
              'metadata.rebalancingInfo.isRebalancing': 1,
            },
            $set: {
              'metadata.rebalancingInfo.failedAt': new Date().toISOString(),
              'metadata.rebalancingInfo.success': false,
              'metadata.rebalancingError': error.message,
              'metadata.rebalancingTimestamp': new Date().toISOString(),
            },
          },
        );

        // Process next position in queue even if this one failed
        const position = await this.aerodromePositionModel.findOne({
          positionId,
        });
        if (position) {
          await this.processNextInQueue(position.walletLocator);
        }
      } catch (updateError) {
        console.error('Failed to update position status:', updateError);
      }

      throw new HttpException(
        `Failed to rebalance position ${positionId}: ${error.message}`,
        error.status || 500,
      );
    }
  }

  /**
   * Generalized swap helper for any token pair using 0x API first, then falling back to 1inch if 0x fails.
   * Returns the buyAmount (in base units) and the transaction result.
   */
  private async swapTokens(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmountRaw: string,
  ): Promise<{
    buyAmount: string;
    quotedBuyAmount?: string;
    minBuyAmount?: string;
    txResult: any;
  }> {
    const walletAddress = this.getWalletAddressFromLocator(walletLocator);
    const slippagePercent = 0.3; // Fixed 0.3% slippage

    console.log('=== Starting swap with 0x fallback to 1inch ===');
    console.log('Parameters:', {
      walletLocator,
      sellToken,
      buyToken,
      sellAmountRaw,
      slippagePercent,
    });

    let last0xError = null;
    let last1inchError = null;
    const maxSwapRetries = 3;

    // Try 0x first with retries
    for (let attempt = 1; attempt <= maxSwapRetries; attempt++) {
      try {
        console.log(
          `Attempting swap with 0x (attempt ${attempt}/${maxSwapRetries})...`,
        );
        return await this.swapWith0x(
          walletLocator,
          sellToken,
          buyToken,
          sellAmountRaw,
          walletAddress,
        );
      } catch (error) {
        last0xError = error;
        console.error(`0x swap attempt ${attempt} failed:`, error.message);

        if (attempt < maxSwapRetries) {
          const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(`Retrying 0x swap in ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    console.error('All 0x swap attempts failed, falling back to 1inch...');

    // Fall back to 1inch with retries
    for (let attempt = 1; attempt <= maxSwapRetries; attempt++) {
      try {
        console.log(
          `Attempting swap with 1inch (attempt ${attempt}/${maxSwapRetries})...`,
        );
        return await this.swapWith1inch(
          walletLocator,
          sellToken,
          buyToken,
          sellAmountRaw,
          slippagePercent,
          walletAddress,
        );
      } catch (error) {
        last1inchError = error;
        console.error(`1inch swap attempt ${attempt} failed:`, error.message);

        if (attempt < maxSwapRetries) {
          const waitTime = Math.min(2000 * Math.pow(2, attempt - 1), 10000);
          console.log(`Retrying 1inch swap in ${waitTime}ms...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
    }

    console.error('Both 0x and 1inch swaps failed after all retries:', {
      oxError: last0xError?.message,
      oneInchError: last1inchError?.message,
    });

    throw new Error(
      `Swap failed on both 0x and 1inch after ${maxSwapRetries} attempts each. 0x error: ${last0xError?.message}. 1inch error: ${last1inchError?.message}`,
    );
  }

  /**
   * Swap using 0x API
   */
  private async swapWith0x(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmountRaw: string,
    walletAddress: string,
  ): Promise<{
    buyAmount: string;
    quotedBuyAmount?: string;
    minBuyAmount?: string;
    txResult: any;
  }> {
    console.log('=== Executing 0x Swap ===');

    // Get pre-swap balances
    const preSwapSellBalance = await this.readContract(
      sellToken,
      ERC20_ABI as unknown as any[],
      'balanceOf',
      [walletAddress],
    );

    const preSwapBuyBalance = await this.readContract(
      buyToken,
      ERC20_ABI as unknown as any[],
      'balanceOf',
      [walletAddress],
    );

    // Decode the balances
    const { decodeFunctionResult } = await import('viem');
    const decodedPreSwapSellBalance = decodeFunctionResult({
      abi: ERC20_ABI as any,
      functionName: 'balanceOf',
      data: preSwapSellBalance,
    });

    const decodedPreSwapBuyBalance = decodeFunctionResult({
      abi: ERC20_ABI as any,
      functionName: 'balanceOf',
      data: preSwapBuyBalance,
    });

    console.log('Pre-swap balances:');
    console.log('Sell token balance:', decodedPreSwapSellBalance.toString());
    console.log('Buy token balance:', decodedPreSwapBuyBalance.toString());

    // Get price quote and swap quote
    const priceQuote = await this.get0xPrice(
      sellToken,
      buyToken,
      sellAmountRaw,
      walletAddress,
    );

    // Approve if needed
    if (priceQuote.issues?.allowance) {
      await this.handleTokenApproval(
        walletLocator,
        sellToken,
        priceQuote.issues.allowance.spender,
        BigInt(sellAmountRaw),
      );
    }

    // Get swap quote
    const swapQuote = await this.get0xQuote(
      sellToken,
      buyToken,
      sellAmountRaw,
      walletAddress,
    );

    // Execute swap
    const txResult = await this.sendRawTransaction(
      walletLocator,
      swapQuote.transaction.to,
      swapQuote.transaction.data,
      swapQuote.transaction.value || '0',
    );

    console.log('=== 0x Swap Transaction Result ===');
    console.log('Transaction Hash:', txResult?.transactionHash);
    console.log('Expected Buy Amount:', swapQuote.buyAmount);
    console.log('Transaction Status:', txResult?.status);

    // Get the actual buy amount from Transfer events
    let buyBalanceChange = BigInt(0);

    if (txResult?.status === 'success') {
      // Wait a bit for the transaction to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get the actual buy amount from Transfer events
      buyBalanceChange = await this.getBuyAmountFromTransferEvents(
        txResult.transactionHash,
        buyToken,
        walletAddress,
      );

      console.log(
        'Buy amount from Transfer events:',
        buyBalanceChange.toString(),
      );
      console.log('Expected min buy amount:', swapQuote.minBuyAmount);

      // Verify that we received at least the minimum expected amount
      const expectedMinBuyAmount = BigInt(swapQuote.minBuyAmount);
      const buyAmountCheck = buyBalanceChange >= expectedMinBuyAmount;

      console.log('Verification results:');
      console.log('Buy amount check passed:', buyAmountCheck);

      if (!buyAmountCheck) {
        const errorMessage = `0x swap transaction succeeded but buy amount is below minimum. Transaction hash: ${txResult?.transactionHash}. Expected min buy change: ${expectedMinBuyAmount}, Actual buy change: ${buyBalanceChange}`;
        console.error('=== SWAP VERIFICATION FAILED ===');
        console.error(errorMessage);
        throw new Error(errorMessage);
      }

      console.log('=== SWAP VERIFICATION SUCCESSFUL ===');
      console.log('Token transfer confirmed. Swap was successful.');
    }

    // Return actual buy amount, along with quoted and min expected amounts for slippage analysis
    return {
      buyAmount: buyBalanceChange.toString(),
      quotedBuyAmount: swapQuote.buyAmount,
      minBuyAmount: swapQuote.minBuyAmount,
      txResult,
    };
  }

  /**
   * Swap using 1inch API
   */
  private async swapWith1inch(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmountRaw: string,
    slippagePercent: number,
    walletAddress: string,
  ): Promise<{
    buyAmount: string;
    quotedBuyAmount?: string;
    minBuyAmount?: string;
    txResult: any;
  }> {
    console.log('=== Executing 1inch Swap ===');

    try {
      // Get spender address for approval
      const spenderAddress = await this.get1inchSpender();
      console.log('spenderAddress', spenderAddress);

      // Get pre-swap balances
      const preSwapSellBalance = await this.readContract(
        sellToken,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );

      const preSwapBuyBalance = await this.readContract(
        buyToken,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );

      // Decode the balances
      const { decodeFunctionResult } = await import('viem');
      const decodedPreSwapSellBalance = decodeFunctionResult({
        abi: ERC20_ABI as any,
        functionName: 'balanceOf',
        data: preSwapSellBalance,
      });

      const decodedPreSwapBuyBalance = decodeFunctionResult({
        abi: ERC20_ABI as any,
        functionName: 'balanceOf',
        data: preSwapBuyBalance,
      });

      console.log('Pre-swap balances:');
      console.log('Sell token balance:', decodedPreSwapSellBalance.toString());
      console.log('Buy token balance:', decodedPreSwapBuyBalance.toString());

      // Approve token for 1inch spender
      console.log('Approving token for 1inch spender...');
      await this.handleTokenApproval(
        walletLocator,
        sellToken,
        spenderAddress,
        BigInt(sellAmountRaw),
      );

      const swapParams = {
        src: sellToken,
        dst: buyToken,
        amount: sellAmountRaw,
        from: walletAddress,
        origin: walletAddress,
        slippage: slippagePercent.toString(),
      };
      const swapResponse = await this.make1inchRequest<OneInchSwapResponse>(
        `/swap/v6.0/${base.id}/swap`,
        swapParams,
      );

      // Execute swap using 1inch transaction data
      console.log('Executing 1inch swap transaction...');
      const txResult = await this.sendRawTransaction(
        walletLocator,
        swapResponse.tx.to,
        swapResponse.tx.data,
        swapResponse.tx.value || '0',
      );

      console.log('=== 1inch Swap Transaction Result ===');
      console.log('Transaction Hash:', txResult?.transactionHash);
      console.log(
        'Expected Buy Amount:',
        swapResponse.dstAmount || sellAmountRaw,
      );
      console.log('Transaction Status:', txResult?.status);

      // Get the actual buy amount from Transfer events
      let buyBalanceChange = BigInt(0);
      let quotedAmountStrLocal: string | undefined;
      let minBuyAmountLocal: string | undefined;

      if (txResult?.status === 'success') {
        // Wait a bit for the transaction to be processed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Get the actual buy amount from Transfer events
        buyBalanceChange = await this.getBuyAmountFromTransferEvents(
          txResult.transactionHash,
          buyToken,
          walletAddress,
        );

        console.log(
          'Buy amount from Transfer events:',
          buyBalanceChange.toString(),
        );
        console.log(
          'Expected buy amount:',
          swapResponse.dstAmount || swapResponse.toTokenAmount,
        );

        // Verify that we received at least the expected amount
        const quotedAmountStr =
          swapResponse.dstAmount || swapResponse.toTokenAmount || '0';
        const quotedAmount = BigInt(quotedAmountStr);

        // Calculate minimum buy amount by applying slippage tolerance
        // If slippage is 0.3%, we accept 99.7% of the quoted amount
        const slippageMultiplier = (100 - slippagePercent) / 100;
        const expectedMinBuyAmount =
          (quotedAmount * BigInt(Math.floor(slippageMultiplier * 10000))) /
          BigInt(10000);

        const buyAmountCheck = buyBalanceChange >= expectedMinBuyAmount;
        quotedAmountStrLocal = quotedAmountStr;
        minBuyAmountLocal = expectedMinBuyAmount.toString();

        console.log('Verification results:');
        console.log('Quoted amount:', quotedAmount.toString());
        console.log('Slippage tolerance:', slippagePercent + '%');
        console.log(
          'Minimum expected amount:',
          expectedMinBuyAmount.toString(),
        );
        console.log('Actual received amount:', buyBalanceChange.toString());
        console.log('Buy amount check passed:', buyAmountCheck);

        if (!buyAmountCheck) {
          // Calculate the shortfall
          const shortfall = expectedMinBuyAmount - buyBalanceChange;
          const shortfallPercentage =
            Number((shortfall * BigInt(10000)) / expectedMinBuyAmount) / 100;

          console.log('=== SWAP VERIFICATION - SHORTFALL DETECTED ===');
          console.log('Shortfall amount:', shortfall.toString());
          console.log('Shortfall percentage:', shortfallPercentage + '%');

          // If shortfall is small (less than 5%), try to swap the difference
          if (shortfallPercentage <= 5) {
            console.log(
              'Shortfall is small, attempting to swap the difference...',
            );

            // Calculate how much more sell token we need to swap to get the missing amount
            // We'll use a simple ratio: (shortfall / received_amount) * original_sell_amount
            const additionalSellAmount =
              (BigInt(sellAmountRaw) * shortfall) / buyBalanceChange;

            console.log(
              'Additional sell amount needed:',
              additionalSellAmount.toString(),
            );

            // Check if we have enough balance for the additional swap
            const currentSellBalance = await this.readContract(
              sellToken,
              ERC20_ABI as unknown as any[],
              'balanceOf',
              [walletAddress],
            );

            const { decodeFunctionResult } = await import('viem');
            const decodedCurrentSellBalance = decodeFunctionResult({
              abi: ERC20_ABI as any,
              functionName: 'balanceOf',
              data: currentSellBalance,
            });

            console.log(
              'Current sell token balance:',
              decodedCurrentSellBalance.toString(),
            );

            if (
              BigInt(decodedCurrentSellBalance.toString()) >=
              additionalSellAmount
            ) {
              try {
                console.log('Attempting to swap the difference...');
                const additionalSwapResult = await this.swapWith1inch(
                  walletLocator,
                  sellToken,
                  buyToken,
                  additionalSellAmount.toString(),
                  slippagePercent,
                  walletAddress,
                );

                // Add the additional amount to our total
                const totalBuyAmount =
                  buyBalanceChange + BigInt(additionalSwapResult.buyAmount);
                console.log(
                  'Total buy amount after additional swap:',
                  totalBuyAmount.toString(),
                );

                // Verify the total amount meets our minimum
                if (totalBuyAmount >= expectedMinBuyAmount) {
                  console.log(
                    '=== SWAP VERIFICATION SUCCESSFUL (with additional swap) ===',
                  );
                  return { buyAmount: totalBuyAmount.toString(), txResult };
                } else {
                  console.log(
                    'Additional swap still insufficient, but accepting partial result',
                  );
                  return { buyAmount: totalBuyAmount.toString(), txResult };
                }
              } catch (additionalSwapError) {
                console.error(
                  'Additional swap failed:',
                  additionalSwapError.message,
                );
                console.log('Accepting partial result from original swap');
                return { buyAmount: buyBalanceChange.toString(), txResult };
              }
            } else {
              console.log(
                'Insufficient balance for additional swap, accepting partial result',
              );
              return { buyAmount: buyBalanceChange.toString(), txResult };
            }
          } else {
            // Shortfall is too large, throw error for retry
            const errorMessage = `1inch swap transaction succeeded but buy amount is below minimum. Transaction hash: ${txResult?.transactionHash}. Expected min buy change: ${expectedMinBuyAmount}, Actual buy change: ${buyBalanceChange}, Shortfall: ${shortfallPercentage}%`;
            console.error('=== SWAP VERIFICATION FAILED ===');
            console.error(errorMessage);
            throw new Error(errorMessage);
          }
        }

        console.log('=== SWAP VERIFICATION SUCCESSFUL ===');
        console.log('Token transfer confirmed. Swap was successful.');
      }

      // Return actual buy amount, plus quoted and computed min expected amounts when available
      return {
        buyAmount: buyBalanceChange.toString(),
        quotedBuyAmount: quotedAmountStrLocal,
        minBuyAmount: minBuyAmountLocal,
        txResult,
      };
    } catch (error) {
      console.error('1inch swap failed:', error);

      // If the quote failed, try with a different approach
      if (
        error.message.includes('Invalid 1inch quote response') ||
        error.message.includes('Cannot read properties of undefined')
      ) {
        console.log('Trying alternative 1inch approach...');
        return await this.swapWith1inchAlternative(
          walletLocator,
          sellToken,
          buyToken,
          sellAmountRaw,
          slippagePercent,
          walletAddress,
        );
      }

      throw error;
    }
  }

  /**
   * Alternative 1inch swap method using swap endpoint directly
   */
  private async swapWith1inchAlternative(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmountRaw: string,
    slippagePercent: number,
    walletAddress: string,
  ): Promise<{
    buyAmount: string;
    quotedBuyAmount?: string;
    minBuyAmount?: string;
    txResult: any;
  }> {
    console.log('=== Executing Alternative 1inch Swap ===');

    // Get pre-swap balances
    const preSwapSellBalance = await this.readContract(
      sellToken,
      ERC20_ABI as unknown as any[],
      'balanceOf',
      [walletAddress],
    );

    const preSwapBuyBalance = await this.readContract(
      buyToken,
      ERC20_ABI as unknown as any[],
      'balanceOf',
      [walletAddress],
    );

    // Decode the balances
    const { decodeFunctionResult } = await import('viem');
    const decodedPreSwapSellBalance = decodeFunctionResult({
      abi: ERC20_ABI as any,
      functionName: 'balanceOf',
      data: preSwapSellBalance,
    });

    const decodedPreSwapBuyBalance = decodeFunctionResult({
      abi: ERC20_ABI as any,
      functionName: 'balanceOf',
      data: preSwapBuyBalance,
    });

    console.log('Pre-swap balances:');
    console.log('Sell token balance:', decodedPreSwapSellBalance.toString());
    console.log('Buy token balance:', decodedPreSwapBuyBalance.toString());

    // Get spender address first
    const spenderAddress = await this.get1inchSpender();

    // Approve token for 1inch spender
    console.log('Approving token for 1inch spender...');
    await this.handleTokenApproval(
      walletLocator,
      sellToken,
      spenderAddress,
      BigInt(sellAmountRaw),
    );

    // Get the swap transaction data directly
    const swapParams = {
      src: sellToken,
      dst: buyToken,
      amount: sellAmountRaw,
      from: walletAddress,
      origin: walletAddress,
      slippage: slippagePercent.toString(),
    };

    const swapResponse = await this.make1inchRequest<{
      tx: { to: string; data: string; value: string };
    }>(`/swap/v6.0/${base.id}/swap`, swapParams);

    console.log('1inch swap transaction data received');

    // Execute the swap
    console.log('Executing 1inch swap transaction...');
    const txResult = await this.sendRawTransaction(
      walletLocator,
      swapResponse.tx.to,
      swapResponse.tx.data,
      swapResponse.tx.value || '0',
    );

    console.log('=== Alternative 1inch Swap Transaction Result ===');
    console.log('Transaction Hash:', txResult?.transactionHash);
    console.log('Transaction Status:', txResult?.status);

    // Get the actual buy amount from Transfer events
    let buyBalanceChange = BigInt(0);

    if (txResult?.status === 'success') {
      // Wait a bit for the transaction to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get the actual buy amount from Transfer events
      buyBalanceChange = await this.getBuyAmountFromTransferEvents(
        txResult.transactionHash,
        buyToken,
        walletAddress,
      );

      console.log(
        'Buy amount from Transfer events:',
        buyBalanceChange.toString(),
      );

      // Verify that we received some reasonable amount
      const minExpectedBuyChange = BigInt(1000); // Minimum 1000 wei increase for buy token
      const buyAmountCheck = buyBalanceChange >= minExpectedBuyChange;

      console.log('Verification results:');
      console.log('Buy amount check passed:', buyAmountCheck);

      if (!buyAmountCheck) {
        const errorMessage = `Alternative 1inch swap transaction succeeded but buy amount is below minimum. Transaction hash: ${txResult?.transactionHash}. Expected min buy change: ${minExpectedBuyChange}, Actual buy change: ${buyBalanceChange}`;
        console.error('=== SWAP VERIFICATION FAILED ===');
        console.error(errorMessage);
        throw new Error(errorMessage);
      }

      console.log('=== SWAP VERIFICATION SUCCESSFUL ===');
      console.log('Token transfer confirmed. Swap was successful.');
    }

    // Return actual amount; quote/min not available in this path
    return { buyAmount: buyBalanceChange.toString(), txResult };
  }

  // === POSITION ANALYSIS METHODS ===

  // Remove the pool rotation interval since we're now evaluating all pools
  // private readonly POOL_ROTATION_INTERVAL = 2 * 60 * 1000; // 2 minutes in milliseconds

  /**
   * Get all pools that should be analyzed in the current cron run
   * Now evaluates all pools simultaneously instead of rotating
   */
  private getAllPoolsToAnalyze(): string[] {
    const pools = ['weth-usdc']; // Temporarily disable usdc-usd+ until we have the correct address
    console.log(`Analyzing all pools simultaneously: ${pools.join(', ')}`);
    return pools;
  }

  /**
   * Get all active positions across all pools
   */
  async getAllActivePositions(): Promise<any[]> {
    const allPools = this.getAllPoolsToAnalyze();

    console.log(`=== Analyzing All Pools: ${allPools.join(', ')} ===`);

    const allPositions = await this.aerodromePositionModel.find({
      status: 'active',
      pool: { $in: allPools },
    });

    console.log(
      `Found ${allPositions.length} active positions across all pools`,
    );

    // Group positions by pool for logging
    const positionsByPool = allPools.reduce(
      (acc, pool) => {
        acc[pool] = allPositions.filter((pos) => pos.pool === pool).length;
        return acc;
      },
      {} as Record<string, number>,
    );

    console.log('Positions by pool:', positionsByPool);

    return allPositions;
  }

  /**
   * Get positions that need rebalancing, ensuring no duplicates
   * This is the main function that will be called by the cron job
   */
  async getPositionsNeedingRebalancing(): Promise<{
    outOfRange: any[];
    performanceLoss: any[];
  }> {
    try {
      console.log(
        '=== Getting Positions Needing Rebalancing (Out-of-Range + Performance Loss) ===',
      );

      // Get active positions for current pool
      const activePositions = await this.getAllActivePositions();

      if (activePositions.length === 0) {
        console.log('No active positions found for current pool');
        return {
          outOfRange: [],
          performanceLoss: [],
        };
      }

      // Get wallets that are currently rebalancing (this will automatically clear stuck states)
      const rebalancingWallets = await this.getRebalancingWallets();
      console.log('Wallets currently rebalancing:', rebalancingWallets);

      // Debug: Check if the stuck wallet is being cleared
      const stuckWallet = '0xF2de711e43409f64aD848449612Ba4069DE418E5';
      if (rebalancingWallets.includes(stuckWallet)) {
        console.log(
          `⚠️  WARNING: Wallet ${stuckWallet} is still in rebalancing state and will be excluded`,
        );
      } else {
        console.log(
          `✅ SUCCESS: Wallet ${stuckWallet} is no longer in rebalancing state`,
        );
      }

      // Filter out positions from wallets that are already rebalancing
      const availablePositions = activePositions.filter(
        (position) =>
          !rebalancingWallets.includes(position.walletLocator) &&
          position.metadata?.strategyName !== 'fee-optimiser' &&
          position.metadata?.strategyName !== 'fee-optimiser-v2',
      );

      console.log(
        `Available positions (excluding rebalancing wallets): ${availablePositions.length}`,
      );

      const results = {
        outOfRange: [] as any[],
        performanceLoss: [] as any[],
      };

      console.log(
        'availablePositions',
        availablePositions.map((pos) => pos.positionId),
      );

      // Check for out-of-range positions (highest priority)
      const outOfRangePositions =
        await this.getOutOfRangePositions(availablePositions);
      results.outOfRange = outOfRangePositions;

      // Check for performance loss positions (1% deviation + -0.56% loss)
      const performanceLossPositions =
        await this.getPerformanceLossPositions(availablePositions);
      results.performanceLoss = performanceLossPositions;

      console.log('Rebalancing analysis results:', {
        outOfRange: results.outOfRange.length,
        performanceLoss: results.performanceLoss.length,
      });

      return results;
    } catch (error) {
      console.error('Error getting positions needing rebalancing:', error);
      throw error;
    }
  }
  /**
   * Check which positions are out of range (current tick outside position's tick range)
   * This is the highest priority rebalancing condition
   */
  private async getOutOfRangePositions(activePositions: any[]): Promise<any[]> {
    try {
      console.log('=== Checking for Out-of-Range Positions ===');

      if (activePositions.length === 0) {
        console.log('No active positions to check for out-of-range');
        return [];
      }

      // Get all pools to analyze
      const allPools = this.getAllPoolsToAnalyze();
      const outOfRangePositions: any[] = [];

      // Check each pool for out-of-range positions
      for (const pool of allPools) {
        const poolConfig = getPoolConfig(pool);

        if (!poolConfig) {
          console.warn(`Pool config not found for pool ${pool}`);
          continue;
        }

        // Get current tick from pool (single blockchain call per pool)
        const slot0Result = await this.readContract(
          poolConfig.address,
          poolAbi as unknown as any[],
          'slot0',
          [],
        );
        const decodedResult = this.decodeSlot0Result(slot0Result);
        const currentTick = decodedResult.tick;

        console.log(`Pool ${pool} current tick: ${currentTick}`);

        // Filter positions for this specific pool that are out of range
        const poolPositions = activePositions.filter(
          (pos) => pos.pool === pool,
        );
        console.log(`Found ${poolPositions.length} positions for pool ${pool}`);

        const poolOutOfRangePositions = poolPositions.filter((position) => {
          const tickRange = position.metadata?.tickRange;

          if (
            !tickRange ||
            tickRange.tickLower === undefined ||
            tickRange.tickUpper === undefined
          ) {
            console.warn(
              `Position ${position.positionId} missing tick range data`,
            );
            return false;
          }

          // Check if position is less than 30 minutes old
          const positionCreatedAt = new Date(position.createdAt);
          const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

          if (positionCreatedAt > fifteenMinutesAgo) {
            console.log(
              `Position ${position.positionId} is less than 15 minutes old (created at ${positionCreatedAt.toISOString()}), skipping rebalancing`,
            );
            return false;
          }

          // Apply buffer only for percentDeviation = 0.5 to prevent premature rebalancing
          const percentDeviation =
            position.metadata?.tickRange?.percentDeviation || 0.5;
          const buffer = percentDeviation === 0.5 ? 10 : 0; // Only 10 ticks buffer for 0.5% positions

          const isOutOfRange =
            currentTick < tickRange.tickLower - buffer ||
            currentTick > tickRange.tickUpper + buffer;

          console.log(`Position ${position.positionId} tick check:`, {
            currentTick,
            tickLower: tickRange.tickLower,
            tickUpper: tickRange.tickUpper,
            percentDeviation,
            buffer,
            effectiveLower: tickRange.tickLower - buffer,
            effectiveUpper: tickRange.tickUpper + buffer,
            isOutOfRange,
            belowLower: currentTick < tickRange.tickLower - buffer,
            aboveUpper: currentTick > tickRange.tickUpper + buffer,
            positionAge: `${Math.round((Date.now() - positionCreatedAt.getTime()) / (1000 * 60))} minutes`,
          });

          if (isOutOfRange) {
            console.log(
              `Position ${position.positionId} is out of range: current tick ${currentTick} outside buffered range [${tickRange.tickLower - buffer}, ${tickRange.tickUpper + buffer}] (original range: [${tickRange.tickLower}, ${tickRange.tickUpper}])`,
            );
          }

          return isOutOfRange;
        });

        outOfRangePositions.push(...poolOutOfRangePositions);
      }

      console.log(
        `Found ${outOfRangePositions.length} out-of-range positions across all pools`,
      );
      return outOfRangePositions;
    } catch (error) {
      console.error('Error checking for out-of-range positions:', error);
      return []; // Return empty array on error to avoid breaking the entire process
    }
  }

  /**
   * Check which positions need rebalancing due to performance loss
   * Condition: tickRange.percentDeviation === 1 OR 0.5% with different thresholds
   */
  private async getPerformanceLossPositions(
    activePositions: any[],
  ): Promise<any[]> {
    try {
      console.log('=== Checking for Performance Loss Positions ===');

      if (activePositions.length === 0) {
        console.log('No active positions to check for performance loss');
        return [];
      }

      const performanceLossPositions: any[] = [];

      for (const position of activePositions) {
        try {
          // Check if position has 1% or 0.5% deviation (only these support performance loss rebalancing)
          const percentDeviation =
            position.metadata?.tickRange?.percentDeviation;
          if (percentDeviation !== 1 && percentDeviation !== 0.5) {
            continue; // Skip positions that don't have 1% or 0.5% deviation
          }

          // Check if position has position history
          const positionHistory = position.metadata?.positionHistory;
          if (!positionHistory || positionHistory.length === 0) {
            console.log(
              `Position ${position.positionId} has no position history, skipping performance loss check`,
            );
            continue;
          }

          // Get the most recent position history entry
          const lastHistoryEntry = positionHistory[positionHistory.length - 1];
          const percentageChange =
            lastHistoryEntry?.performance?.percentageChange;

          if (percentageChange === undefined || percentageChange === null) {
            console.log(
              `Position ${position.positionId} has no percentage change in last history entry, skipping`,
            );
            continue;
          }

          // NEW TOP CONDITION: Check for significant unused amounts
          const mintDetails = position.metadata?.mintDetails;
          if (mintDetails?.amount0Unused && position.usdcAmount) {
            const amount0UnusedValue =
              parseFloat(mintDetails.amount0Unused) / 1e18; // Convert from wei to ETH
            const usdcAmountValue = parseFloat(position.usdcAmount); // Already in human readable format

            // Get current ETH price from the position's token0PriceAtMint or calculate it
            const currentEthPrice = mintDetails.token0PriceAtMint || 0;
            const amount0UnusedValueUSD = amount0UnusedValue * currentEthPrice;

            // Calculate the percentage of unused amount relative to USDC amount
            const unusedPercentage =
              (amount0UnusedValueUSD / usdcAmountValue) * 100;

            // Different thresholds for 0.5% vs 1% deviation
            const unusedThreshold = percentDeviation === 0.5 ? -0.25 : -0.32;
            const unusedPercentageThreshold =
              percentDeviation === 0.5 ? 15 : 20;

            if (
              unusedPercentage > unusedPercentageThreshold &&
              percentageChange < unusedThreshold
            ) {
              console.log(
                `Position ${position.positionId} meets unused amount condition:`,
                {
                  percentDeviation,
                  percentageChange,
                  threshold: unusedThreshold,
                  unusedPercentageThreshold,
                  amount0UnusedValue,
                  currentEthPrice,
                  amount0UnusedValueUSD,
                  usdcAmountValue,
                  unusedPercentage: `${unusedPercentage.toFixed(2)}%`,
                  timestamp: lastHistoryEntry.timestamp,
                },
              );

              performanceLossPositions.push(position);
              continue; // Skip other conditions since this is the top priority
            }
          }

          // Different thresholds for 0.5% vs 1% deviation
          const standardThreshold = percentDeviation === 0.5 ? -0.33 : -0.5;
          const trendingThreshold = percentDeviation === 0.5 ? -0.28 : -0.41;
          const historyLengthRequired = percentDeviation === 0.5 ? 3 : 4;

          // Check if percentage change is less than threshold
          if (percentageChange < standardThreshold) {
            console.log(
              `Position ${position.positionId} meets performance loss condition:`,
              {
                percentDeviation,
                percentageChange,
                threshold: standardThreshold,
                timestamp: lastHistoryEntry.timestamp,
              },
            );

            performanceLossPositions.push(position);
          } else if (percentageChange < trendingThreshold) {
            // Check for trending downward pattern over last N iterations (3 for 0.5%, 4 for 1%)
            if (positionHistory.length >= historyLengthRequired) {
              const lastNEntries = positionHistory.slice(
                -historyLengthRequired,
              );
              let isDecreasing = true;

              for (let i = 1; i < lastNEntries.length; i++) {
                const currentChange =
                  lastNEntries[i]?.performance?.percentageChange;
                const previousChange =
                  lastNEntries[i - 1]?.performance?.percentageChange;

                if (
                  currentChange === undefined ||
                  previousChange === undefined
                ) {
                  isDecreasing = false;
                  break;
                }

                // Check if performance is getting worse (more negative)
                if (currentChange >= previousChange) {
                  isDecreasing = false;
                  break;
                }
              }

              if (isDecreasing) {
                console.log(
                  `Position ${position.positionId} meets trending downward condition:`,
                  {
                    percentDeviation,
                    percentageChange,
                    threshold: trendingThreshold,
                    lastNChanges: lastNEntries.map(
                      (entry) => entry?.performance?.percentageChange,
                    ),
                    timestamp: lastHistoryEntry.timestamp,
                  },
                );

                performanceLossPositions.push(position);
              } else {
                console.log(
                  `Position ${position.positionId} does not meet trending downward condition:`,
                  {
                    percentDeviation,
                    percentageChange,
                    threshold: trendingThreshold,
                    lastNChanges: lastNEntries.map(
                      (entry) => entry?.performance?.percentageChange,
                    ),
                    timestamp: lastHistoryEntry.timestamp,
                  },
                );
              }
            } else {
              console.log(
                `Position ${position.positionId} has insufficient history for trending analysis:`,
                {
                  percentDeviation,
                  percentageChange,
                  historyLength: positionHistory.length,
                  requiredLength: historyLengthRequired,
                  timestamp: lastHistoryEntry.timestamp,
                },
              );
            }
          } else {
            console.log(
              `Position ${position.positionId} does not meet performance loss condition:`,
              {
                percentDeviation,
                percentageChange,
                threshold: standardThreshold,
                timestamp: lastHistoryEntry.timestamp,
              },
            );
          }
        } catch (positionError) {
          console.error(
            `Error checking performance loss for position ${position.positionId}:`,
            positionError,
          );
          // Continue with other positions
        }
      }

      console.log(
        `Found ${performanceLossPositions.length} performance loss positions`,
      );
      return performanceLossPositions;
    } catch (error) {
      console.error('Error checking for performance loss positions:', error);
      return []; // Return empty array on error to avoid breaking the entire process
    }
  }

  /**
   * Get current token amounts for a position by calculating liquidity distribution
   * This is used for dollar value condition checking
   */
  private async getCurrentTokenAmounts(position: any): Promise<{
    amount0: bigint;
    amount1: bigint;
    currentTick: number;
  }> {
    try {
      console.log(
        `Getting current token amounts for position ${position.positionId}`,
      );

      // Extract position data
      const tickRange = position.metadata?.tickRange;
      const liquidity = position.metadata?.mintDetails?.liquidity;
      const poolAddress = position.metadata?.poolAddress;

      if (!tickRange || !liquidity || !poolAddress) {
        throw new Error(
          `Position ${position.positionId} missing required data: tickRange, liquidity, or poolAddress`,
        );
      }

      const tickLower = tickRange.tickLower;
      const tickUpper = tickRange.tickUpper;

      console.log('Position data:', {
        tickLower,
        tickUpper,
        liquidity,
        poolAddress,
      });

      // Step 1: Get current tick and sqrtRatioX96 from pool
      console.log('Step 1: Getting current tick from pool...');
      const slot0Result = await this.readContract(
        poolAddress,
        poolAbi as unknown as any[],
        'slot0',
        [],
      );
      const decodedSlot0 = this.decodeSlot0Result(slot0Result);
      const currentTick = decodedSlot0.tick;
      const sqrtRatioX96 = decodedSlot0.sqrtPriceX96;

      console.log('Current pool state:', {
        currentTick,
        sqrtRatioX96,
      });

      // Step 2: Get sqrtRatioAX96 (tickLower) and sqrtRatioBX96 (tickUpper) from TickMath
      console.log('Step 2: Getting sqrt ratios for tick bounds...');
      const sqrtRatioAX96 = await this.readContract(
        this.TICKMATH_ADDRESS,
        TickMathAbi as unknown as any[],
        'getSqrtRatioAtTick',
        [tickLower],
      );

      const sqrtRatioBX96 = await this.readContract(
        this.TICKMATH_ADDRESS,
        TickMathAbi as unknown as any[],
        'getSqrtRatioAtTick',
        [tickUpper],
      );

      console.log('Tick bounds sqrt ratios:', {
        sqrtRatioAX96,
        sqrtRatioBX96,
      });

      // Step 3: Get current amounts using getAmountsForLiquidity
      console.log('Step 3: Calculating current token amounts...');
      const amountsResult = await this.readContract(
        this.LIQUIDITY_AMOUNTS_ADDRESS,
        LiquidityAmountsAbi as unknown as any[],
        'getAmountsForLiquidity',
        [sqrtRatioX96, sqrtRatioAX96, sqrtRatioBX96, liquidity],
      );

      // Decode the result (getAmountsForLiquidity returns [amount0, amount1])
      const decodedAmounts =
        this.decodeAmountsForLiquidityResult(amountsResult);
      const { amount0, amount1 } = decodedAmounts;

      console.log('Current token amounts:', {
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        currentTick,
      });

      return {
        amount0,
        amount1,
        currentTick,
      };
    } catch (error) {
      console.error(
        `Error getting current token amounts for position ${position.positionId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Cleanup function to swap failed mint tokens back to USDC
   * This is called immediately when mint fails to prevent users from being stuck with unwanted tokens
   */
  async cleanupFailedMint(
    positionId: string,
    actualToken0Amount: string,
    actualToken1Amount: string,
    shouldRetry: boolean = false,
  ) {
    try {
      console.log(`=== Cleaning up failed mint for position ${positionId} ===`);

      // Get the position details
      const position = await this.aerodromePositionModel.findOne({
        positionId,
      });
      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }

      // Check if position is already active (successful)
      if (position.status === 'active') {
        console.log(
          `Position ${positionId} is already active (status: ${position.status}), skipping cleanup`,
        );
        return {
          success: true,
          positionId,
          retrySuccessful: false,
          message: `Position already ${position.status}`,
        };
      }

      if (position.status !== 'mint_failed') {
        console.log(
          `Position ${positionId} is not in mint_failed status (current: ${position.status}), skipping cleanup`,
        );
        return {
          success: true,
          positionId,
          retrySuccessful: false,
          message: `Position status is ${position.status}, not mint_failed`,
        };
      }

      const poolConfig = getPoolConfig(position.pool);
      if (!poolConfig) {
        throw new Error(`Pool config not found for ${position.pool}`);
      }

      const walletAddress = this.getWalletAddressFromLocator(
        position.walletLocator,
      );
      console.log('Wallet address for cleanup:', walletAddress);

      // Use the actual amounts that were used in the mint instead of full balances
      const actualToken0AmountBigInt = BigInt(actualToken0Amount);
      const actualToken1AmountBigInt = BigInt(actualToken1Amount);

      // Calculate USD values of the tokens
      let token0USDValue = 0;
      let token1USDValue = 0;

      if (poolConfig.token0 === this.USDC_ADDRESS) {
        // Token0 is USDC, calculate USD value directly
        token0USDValue =
          Number(actualToken0AmountBigInt) / Math.pow(10, this.USDC_DECIMALS);
      } else {
        // Get token0 price and calculate USD value
        try {
          const token0Price = await this.getTokenPriceForSwap(
            poolConfig.token0,
            poolConfig.token0Name,
            poolConfig.token0Decimals,
          );
          token0USDValue =
            (Number(actualToken0AmountBigInt) /
              Math.pow(10, poolConfig.token0Decimals)) *
            token0Price;
        } catch (error) {
          console.error(
            `Failed to get price for ${poolConfig.token0Name}:`,
            error,
          );
          // Use a fallback price or estimate
          token0USDValue = 0;
        }
      }

      if (poolConfig.token1 === this.USDC_ADDRESS) {
        // Token1 is USDC, calculate USD value directly
        token1USDValue =
          Number(actualToken1AmountBigInt) / Math.pow(10, this.USDC_DECIMALS);
      } else {
        // Get token1 price and calculate USD value
        try {
          const token1Price = await this.getTokenPriceForSwap(
            poolConfig.token1,
            poolConfig.token1Name,
            poolConfig.token1Decimals,
          );
          token1USDValue =
            (Number(actualToken1AmountBigInt) /
              Math.pow(10, poolConfig.token1Decimals)) *
            token1Price;
        } catch (error) {
          console.error(
            `Failed to get price for ${poolConfig.token1Name}:`,
            error,
          );
          // Use a fallback price or estimate
          token1USDValue = 0;
        }
      }

      const totalUSDValue = token0USDValue + token1USDValue;

      console.log('Cleanup analysis:', {
        token0: poolConfig.token0Name,
        token1: poolConfig.token1Name,
        actualToken0Amount: actualToken0AmountBigInt.toString(),
        actualToken1Amount: actualToken1AmountBigInt.toString(),
        token0USDValue: token0USDValue.toFixed(2),
        token1USDValue: token1USDValue.toFixed(2),
        totalUSDValue: totalUSDValue.toFixed(2),
      });

      // Store token amounts and USD values for immediate retry
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          status: 'cleanup_completed',
          metadata: {
            ...position.metadata,
            retryMetadata: {
              originalTokenAmounts: {
                token0: actualToken0AmountBigInt.toString(),
                token1: actualToken1AmountBigInt.toString(),
                totalUSDValue: totalUSDValue,
              },
              currentTokenAmounts: {
                token0: actualToken0AmountBigInt.toString(),
                token1: actualToken1AmountBigInt.toString(),
                totalUSDValue: totalUSDValue,
              },
              retryAttempts: 0,
              lastRetryAt: new Date(),
              cleanupCompletedAt: new Date().toISOString(),
            },
          },
        },
      );

      console.log(`=== Cleanup completed for position ${positionId} ===`);

      // If this is a retry scenario, attempt immediate retry
      if (shouldRetry) {
        console.log(`Attempting immediate retry for position ${positionId}...`);

        try {
          // Get the original position data for retry
          const originalPosition = await this.aerodromePositionModel.findOne({
            positionId,
          });

          if (!originalPosition) {
            throw new Error('Original position not found for retry');
          }

          // Create retry DTO with the stored token amounts
          const retryDto = new CreateAerodromeLpDto();
          Object.assign(retryDto, {
            walletLocator: originalPosition.walletLocator,
            pool: originalPosition.pool,
            usdcAmount: totalUSDValue, // Use the calculated USD value
            description: `Retry of failed position ${positionId}`,
            rebalancedPositionId:
              originalPosition.metadata?.rebalancedPositionId || null,
            percentDeviation:
              originalPosition.metadata?.tickRange?.percentDeviation || 1.5,
            strategyName: originalPosition.metadata?.strategyName || null, // Preserve strategy
            isRebalanceOrRetry: true,
            positionId: positionId, // Pass the position ID to get stored token amounts
          });

          console.log('Retry DTO created:', {
            walletLocator: retryDto.walletLocator,
            pool: retryDto.pool,
            usdcAmount: retryDto.usdcAmount,
            percentDeviation: retryDto.percentDeviation,
          });

          // Attempt the retry
          const retryResult = await this.mint(retryDto);

          if (retryResult && retryResult.status === 'active') {
            console.log(
              `✅ Immediate retry successful for position ${positionId}`,
            );
            return {
              success: true,
              positionId,
              retrySuccessful: true,
              newPositionId: retryResult.positionId,
              totalUSDValue: totalUSDValue,
              token0Amount: actualToken0AmountBigInt.toString(),
              token1Amount: actualToken1AmountBigInt.toString(),
              token0USDValue: token0USDValue,
              token1USDValue: token1USDValue,
            };
          } else {
            console.log(`❌ Immediate retry failed for position ${positionId}`);
            throw new Error('Retry mint failed');
          }
        } catch (retryError) {
          console.error(
            `Immediate retry failed for position ${positionId}:`,
            retryError,
          );
          // Return cleanup result even if retry failed
          return {
            success: true,
            positionId,
            retrySuccessful: false,
            retryError: retryError.message,
            totalUSDValue: totalUSDValue,
            token0Amount: actualToken0AmountBigInt.toString(),
            token1Amount: actualToken1AmountBigInt.toString(),
            token0USDValue: token0USDValue,
            token1USDValue: token1USDValue,
          };
        }
      }

      return {
        success: true,
        positionId,
        totalUSDValue: totalUSDValue,
        token0Amount: actualToken0AmountBigInt.toString(),
        token1Amount: actualToken1AmountBigInt.toString(),
        token0USDValue: token0USDValue,
        token1USDValue: token1USDValue,
      };
    } catch (error) {
      console.error(
        `Error cleaning up failed mint for position ${positionId}:`,
        error,
      );

      // Update position with cleanup error
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          status: 'cleanup_failed',
          metadata: {
            cleanupError: error.message,
            cleanupFailedAt: new Date().toISOString(),
          },
        },
      );

      throw error;
    }
  }

  /**
   * Test 1inch integration - useful for debugging
   */
  async test1inchIntegration(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    amount: string,
  ) {
    try {
      console.log('=== Testing 1inch Integration ===');

      const walletAddress = this.getWalletAddressFromLocator(walletLocator);

      // Test spender endpoint
      console.log('Testing spender endpoint...');
      const spender = await this.get1inchSpender();
      console.log('Spender address:', spender);

      // Test quote endpoint
      console.log('Testing quote endpoint...');
      const quote = await this.get1inchSwapQuote(
        sellToken,
        buyToken,
        amount,
        walletAddress,
        1, // 1% slippage
      );

      console.log('Quote received:', {
        fromToken: quote.fromToken?.symbol || 'unknown',
        toToken: quote.toToken?.symbol || 'unknown',
        fromAmount: quote.fromTokenAmount || 'unknown',
        toAmount: quote.toTokenAmount || 'unknown',
        gas: quote.tx?.gas || 'unknown',
        hasTx: !!quote.tx,
        hasTxData: !!(quote.tx?.to && quote.tx?.data),
      });

      return {
        success: true,
        spender,
        quote: {
          fromToken: quote.fromToken?.symbol || 'unknown',
          toToken: quote.toToken?.symbol || 'unknown',
          fromAmount: quote.fromTokenAmount || 'unknown',
          toAmount: quote.toTokenAmount || 'unknown',
          gas: quote.tx?.gas || 'unknown',
          tx: quote.tx
            ? {
                to: quote.tx.to,
                data: quote.tx.data
                  ? quote.tx.data.substring(0, 66) + '...'
                  : 'no data', // Truncate for logging
                value: quote.tx.value || '0',
              }
            : null,
        },
      };
    } catch (error) {
      console.error('1inch integration test failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
  /**
   * Retry failed mints - this is a simplified version for manual testing
   * Note: Immediate retries are now handled in the main mint function
   */
  async retryFailedMints(): Promise<{
    success: boolean;
    message: string;
    results: {
      found: number;
      processed: number;
      successful: number;
      failed: number;
      skipped: number;
    };
  }> {
    try {
      console.log('=== MANUAL RETRY FAILED MINTS ===');

      // Find all positions with mint_failed status created in the past 5 minutes (for manual testing)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const failedPositions = await this.aerodromePositionModel.find({
        status: 'mint_failed',
        createdAt: { $gte: fiveMinutesAgo },
      });

      console.log(`Found ${failedPositions.length} failed positions to retry`);

      const results = {
        found: failedPositions.length,
        processed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
      };

      for (const position of failedPositions) {
        try {
          console.log(`Processing failed position: ${position.positionId}`);
          results.processed++;

          // Prepare mint parameters from the original position data
          const originalPercentDeviation =
            position.metadata?.tickRange?.percentDeviation !== undefined
              ? position.metadata?.tickRange?.percentDeviation
              : 1.5;

          console.log('Original percent deviation:', originalPercentDeviation);
          console.log(
            'Percent deviation:',
            position.metadata?.tickRange?.percentDeviation,
          );

          // Use the stored USD value from retryMetadata if available, otherwise fall back to original usdcAmount
          const retryUSDValue =
            position.retryMetadata?.originalTokenAmounts?.totalUSDValue ||
            position.usdcAmount;

          const mintParams = {
            walletLocator: position.walletLocator,
            pool: position.pool,
            usdcAmount: retryUSDValue,
            description:
              position.metadata?.description ||
              `Retry of failed position ${position.positionId}`,
            rebalancedPositionId:
              position.metadata?.rebalancedPositionId || null,
            percentDeviation: originalPercentDeviation, // Pass the original percentDeviation
            isRebalanceOrRetry: true, // Add flag for retry/rebalancing flow
            positionId: position.positionId, // Pass the position ID to get stored token amounts
          };

          console.log('Mint params with percentDeviation:', {
            percentDeviation: mintParams.percentDeviation,
            type: typeof mintParams.percentDeviation,
            isNumber: typeof mintParams.percentDeviation === 'number',
            isFinite: Number.isFinite(mintParams.percentDeviation),
            value: mintParams.percentDeviation,
          });

          console.log('Retry mint params:', mintParams);
          console.log('Retry mint params keys:', Object.keys(mintParams));
          console.log(
            'Retry mint params has percentDeviation:',
            'percentDeviation' in mintParams,
          );

          // For manual retry, we'll use the cleanup function with retry enabled
          console.log(
            `Processing manual retry for position ${position.positionId}`,
          );

          try {
            // Get the intended token amounts from the original position metadata
            const intendedToken0Amount =
              position.metadata?.tokenAmounts?.rawToken0Amount || '0';
            const intendedToken1Amount =
              position.metadata?.tokenAmounts?.rawToken1Amount || '0';

            console.log(
              `Cleaning up and retrying position ${position.positionId} with actual amounts:`,
              {
                token0: intendedToken0Amount,
                token1: intendedToken1Amount,
              },
            );

            // Clean up and retry the failed position
            const cleanupResult = await this.cleanupFailedMint(
              position.positionId,
              intendedToken0Amount,
              intendedToken1Amount,
              true, // Enable retry
            );

            if (cleanupResult.retrySuccessful) {
              results.successful++;
              console.log(
                `✅ Manual retry successful for position ${position.positionId}`,
              );
            } else {
              results.failed++;
              console.log(
                `❌ Manual retry failed for position ${position.positionId}: ${cleanupResult.retryError}`,
              );
            }
          } catch (cleanupError) {
            console.error(
              `❌ Cleanup/retry failed for position ${position.positionId}:`,
              cleanupError,
            );
            results.failed++;
          }
        } catch (error) {
          console.error(
            `❌ Error processing failed position ${position.positionId}:`,
            error,
          );
          results.failed++;
        }
      }

      return {
        success: true,
        message: `Manual retry completed. Found: ${results.found}, Successful: ${results.successful}, Failed: ${results.failed}`,
        results,
      };
    } catch (error) {
      console.error('=== MANUAL RETRY FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Manual retry failed: ${error.message}`,
        results: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
      };
    }
  }

  /**
   * Main cron function for rebalancing positions
   * This is the entry point that will be called by the cron job
   * Currently handles out-of-range positions, will be extended for other conditions
   */
  async runRebalancingCron(timeSinceLastRun?: number): Promise<{
    success: boolean;
    message: string;
    results: {
      pools: string;
      totalPositions: number;
      feeCollection: {
        totalFeesCollected: number;
        positionsWithFeesCollected: number;
        totalPositions: number;
      };
      outOfRange: {
        found: number;
        processed: number;
        successful: number;
        failed: number;
        skipped: number;
      };
      performanceLoss: {
        found: number;
        processed: number;
        successful: number;
        failed: number;
        skipped: number;
      };
    };
  }> {
    try {
      console.log('=== STARTING REBALANCING CRON ===');
      const startTime = Date.now();

      // Log the time since last run for debugging
      if (timeSinceLastRun) {
        console.log(
          `Time since last rebalancing run: ${(timeSinceLastRun / 1000 / 60).toFixed(2)} minutes`,
        );
      } else {
        console.log('No time since last run provided, using default criteria');
      }

      // Get all pools being analyzed
      const allPools = this.getAllPoolsToAnalyze();
      console.log(`Analyzing all pools: ${allPools.join(', ')}`);

      // Get all active positions for fee collection
      const allActivePositions = await this.getAllActivePositions();
      console.log(
        `Found ${allActivePositions.length} total active positions for fee collection`,
      );

      // Step 1: Collect fees from ALL positions (regardless of rebalancing needs)
      console.log('=== Step 1: Collecting fees from all positions ===');
      let totalFeesCollected = 0;
      let positionsWithFeesCollected = 0;

      for (const position of allActivePositions) {
        try {
          console.log(`Collecting fees for position: ${position.positionId}`);

          // Collect fees (this returns cumulative fees, which is what we want)
          const collectResult = await this.collectFees(
            position.walletLocator,
            position.metadata?.mintDetails?.tokenId,
            false, // Calculate APR to get totalFeesUSD
          );

          const collectedFees = collectResult?.collectedFees?.totalFeesUSD || 0;
          if (collectedFees > 0) {
            totalFeesCollected += collectedFees;
            positionsWithFeesCollected++;
            console.log(
              `✅ Collected $${collectedFees} in fees from position ${position.positionId}`,
            );
          } else {
            console.log(
              `ℹ️ No fees to collect from position ${position.positionId}`,
            );
          }

          // Get position details to update tracking data
          console.log(`Getting position details for ${position.positionId}...`);
          try {
            await this.getPositionDetails(position.positionId);
            console.log(
              `✅ Position details updated for ${position.positionId}`,
            );
          } catch (error) {
            console.warn(
              `⚠️ Failed to get position details for ${position.positionId}:`,
              error.message,
            );
            // Don't fail the cron if position details update fails
          }
        } catch (error) {
          console.error(
            `❌ Error collecting fees from position ${position.positionId}:`,
            error,
          );
        }
      }

      console.log(`=== Fee Collection Summary ===`);
      console.log(`Total fees collected: $${totalFeesCollected}`);
      console.log(
        `Positions with fees collected: ${positionsWithFeesCollected}/${allActivePositions.length}`,
      );

      // Step 1.5: Validate calculated amounts against actual balances for all wallets
      console.log(
        '=== Step 1.5: Validating calculated amounts against actual balances ===',
      );
      await this.validateCalculatedAmountsAgainstBalances(allActivePositions);

      // Step 2: Get positions that need rebalancing
      console.log('=== Step 2: Checking for positions needing rebalancing ===');
      const positionsNeedingRebalancing =
        await this.getPositionsNeedingRebalancing();

      const results = {
        pools: allPools.join(', '),
        totalPositions: allActivePositions.length,
        feeCollection: {
          totalFeesCollected,
          positionsWithFeesCollected,
          totalPositions: allActivePositions.length,
        },
        outOfRange: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
        performanceLoss: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
      };

      // Process out-of-range positions (highest priority)
      results.outOfRange.found = positionsNeedingRebalancing.outOfRange.length;
      console.log(`Found ${results.outOfRange.found} out-of-range positions`);

      for (const position of positionsNeedingRebalancing.outOfRange) {
        try {
          console.log(
            `Processing out-of-range position: ${position.positionId}`,
          );
          results.outOfRange.processed++;

          const rebalanceResult = await this.rebalancePosition(
            position.positionId,
            'out_of_range',
            position.metadata?.strategyName,
          );

          if (rebalanceResult.success) {
            results.outOfRange.successful++;
            console.log(
              `✅ Successfully added position ${position.positionId} to rebalancing queue`,
            );
          } else {
            results.outOfRange.failed++;
            console.log(
              `❌ Failed to add position ${position.positionId} to queue: ${rebalanceResult.message}`,
            );
          }
        } catch (error) {
          results.outOfRange.failed++;
          console.error(
            `❌ Error processing out-of-range position ${position.positionId}:`,
            error,
          );
        }
      }

      // Process performance loss positions (excluding those already in out-of-range)
      const outOfRangePositionIds = positionsNeedingRebalancing.outOfRange.map(
        (p) => p.positionId,
      );
      const uniquePerformanceLossPositions =
        positionsNeedingRebalancing.performanceLoss.filter(
          (position) => !outOfRangePositionIds.includes(position.positionId),
        );

      results.performanceLoss.found = uniquePerformanceLossPositions.length;
      console.log(
        `Found ${results.performanceLoss.found} performance loss positions (after excluding ${positionsNeedingRebalancing.performanceLoss.length - uniquePerformanceLossPositions.length} already in out-of-range)`,
      );

      for (const position of uniquePerformanceLossPositions) {
        try {
          console.log(
            `Processing performance loss position: ${position.positionId}`,
          );
          results.performanceLoss.processed++;

          const rebalanceResult = await this.rebalancePosition(
            position.positionId,
            'performance_loss',
            position.metadata?.strategyName,
          );

          if (rebalanceResult.success) {
            results.performanceLoss.successful++;
            console.log(
              `✅ Successfully added position ${position.positionId} to rebalancing queue`,
            );
          } else {
            results.performanceLoss.failed++;
            console.log(
              `❌ Failed to add position ${position.positionId} to queue: ${rebalanceResult.message}`,
            );
          }
        } catch (error) {
          results.performanceLoss.failed++;
          console.error(
            `❌ Error processing performance loss position ${position.positionId}:`,
            error,
          );
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('=== REBALANCING CRON COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Rebalancing cron completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== REBALANCING CRON FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Rebalancing cron failed: ${error.message}`,
        results: {
          pools: this.getAllPoolsToAnalyze().join(', '),
          totalPositions: 0,
          feeCollection: {
            totalFeesCollected: 0,
            positionsWithFeesCollected: 0,
            totalPositions: 0,
          },
          outOfRange: {
            found: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
          },
          performanceLoss: {
            found: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
          },
        },
      };
    }
  }
  async getPositionDetails(positionId: string) {
    try {
      console.log(`=== Getting Position Details for ${positionId} ===`);

      // Get the position from database
      const position = await this.aerodromePositionModel.findOne({
        positionId,
      });
      if (!position) {
        throw new HttpException('Position not found', 404);
      }

      // Get pool configuration
      const poolConfig = getPoolConfig(position.pool);
      if (!poolConfig) {
        throw new HttpException(
          `Pool configuration not found for: ${position.pool}`,
          400,
        );
      }

      console.log('Position found:', {
        positionId: position.positionId,
        pool: position.pool,
        status: position.status,
      });

      // Get current token amounts
      const { amount0, amount1, currentTick } =
        await this.getCurrentTokenAmounts(position);

      // Get current token prices using 0x
      const dummyWalletAddress = '0xF2de711e43409f64aD848449612Ba4069DE418E5';
      const usdcAmountInBaseUnits = '1000000'; // 1 USDC in base units (6 decimals)

      let token0Price: number;
      let token1Price: number;

      try {
        // Get token0 price via 0x (token0 to USDC)
        const token0PriceQuote = await this.get0xPrice(
          poolConfig.token0, // token0 (WETH)
          this.USDC_ADDRESS, // USDC
          this.toRawAmount(1, poolConfig.token0Decimals).toString(), // 1 WETH in base units
          dummyWalletAddress,
        );
        // Calculate price from buyAmount and sellAmount
        // buyAmount is in USDC (6 decimals), sellAmount is in WETH (18 decimals)
        const buyAmount = parseFloat(token0PriceQuote.buyAmount);
        const sellAmount = parseFloat(token0PriceQuote.sellAmount);
        token0Price = (buyAmount * Math.pow(10, 12)) / sellAmount; // Convert to proper price ratio

        // Get token1 price via 0x (USDC to token1)
        const token1PriceQuote = await this.get0xPrice(
          poolConfig.token1, // token1 (usually USDC, so price should be 1)
          this.USDC_ADDRESS,
          usdcAmountInBaseUnits,
          dummyWalletAddress,
        );
        // For USDC to USDC, the price should be 1
        // But if we're getting a quote, calculate it properly
        if (token1PriceQuote.buyAmount && token1PriceQuote.sellAmount) {
          const buyAmount = parseFloat(token1PriceQuote.buyAmount);
          const sellAmount = parseFloat(token1PriceQuote.sellAmount);
          token1Price = buyAmount / sellAmount; // Both are in USDC (6 decimals)
        } else {
          token1Price = 1; // USDC price is always 1
        }

        console.log('Token prices from 0x:', {
          token0Name: poolConfig.token0Name,
          token1Name: poolConfig.token1Name,
          token0Price,
          token1Price,
        });
      } catch (error) {
        console.error(
          'Failed to get prices from 0x, falling back to getTokenPrice:',
          error,
        );
        // Fallback to original method
        token0Price = await this.getTokenPrice(poolConfig.token0Name);
        token1Price = await this.getTokenPrice(poolConfig.token1Name);
      }

      console.log('Token prices:', {
        token0Name: poolConfig.token0Name,
        token1Name: poolConfig.token1Name,
        token0Price,
        token1Price,
      });

      // Convert amounts to human-readable values
      const amount0Human =
        Number(amount0) / Math.pow(10, poolConfig.token0Decimals);
      const amount1Human =
        Number(amount1) / Math.pow(10, poolConfig.token1Decimals);

      console.log('Token amounts (human):', {
        amount0Human,
        amount1Human,
        token0Decimals: poolConfig.token0Decimals,
        token1Decimals: poolConfig.token1Decimals,
      });

      // Calculate current dollar values
      const token0DollarValue = amount0Human * token0Price;
      const token1DollarValue = amount1Human * token1Price;
      const totalCurrentDollarValue = token0DollarValue + token1DollarValue;

      // Calculate current token mix/ratio
      const tokenMix = {
        token0Percentage:
          totalCurrentDollarValue > 0
            ? (token0DollarValue / totalCurrentDollarValue) * 100
            : 0,
        token1Percentage:
          totalCurrentDollarValue > 0
            ? (token1DollarValue / totalCurrentDollarValue) * 100
            : 0,
        token0ToToken1Ratio: amount1Human > 0 ? amount0Human / amount1Human : 0,
        token1ToToken0Ratio: amount0Human > 0 ? amount1Human / amount0Human : 0,
        dollarValueRatio:
          token1DollarValue > 0 ? token0DollarValue / token1DollarValue : 0,
      };

      console.log('Token mix calculated:', {
        token0Percentage: `${tokenMix.token0Percentage.toFixed(2)}%`,
        token1Percentage: `${tokenMix.token1Percentage.toFixed(2)}%`,
        token0ToToken1Ratio: tokenMix.token0ToToken1Ratio.toFixed(6),
        dollarValueRatio: tokenMix.dollarValueRatio.toFixed(4),
      });

      // Check if actualUsdcAmount already exists, if not calculate it
      let actualUsdcAmount = position.actualUsdcAmount;

      if (actualUsdcAmount === undefined || actualUsdcAmount === null) {
        console.log(`Calculating actualUsdcAmount for position ${positionId}`);

        const mintDetails = position.metadata?.mintDetails;
        if (
          mintDetails &&
          mintDetails.token0PriceAtMint !== undefined &&
          mintDetails.token1PriceAtMint !== undefined &&
          mintDetails.amount0 !== undefined &&
          mintDetails.amount1 !== undefined
        ) {
          // Convert raw amounts to human readable forms
          const amount0Human =
            Number(mintDetails.amount0) /
            Math.pow(10, poolConfig.token0Decimals);
          const amount1Human =
            Number(mintDetails.amount1) /
            Math.pow(10, poolConfig.token1Decimals);

          // Calculate actual USDC amount invested
          const token0Value =
            amount0Human * Number(mintDetails.token0PriceAtMint);
          const token1Value =
            amount1Human * Number(mintDetails.token1PriceAtMint);
          actualUsdcAmount = token0Value + token1Value;

          console.log('Actual USDC amount calculation:', {
            amount0Raw: mintDetails.amount0,
            amount1Raw: mintDetails.amount1,
            amount0Human: `${amount0Human.toFixed(6)} ${poolConfig.token0Name}`,
            amount1Human: `${amount1Human.toFixed(6)} ${poolConfig.token1Name}`,
            token0PriceAtMint: `$${mintDetails.token0PriceAtMint}`,
            token1PriceAtMint: `$${mintDetails.token1PriceAtMint}`,
            token0Value: `$${token0Value.toFixed(2)}`,
            token1Value: `$${token1Value.toFixed(2)}`,
            actualUsdcAmount: `$${actualUsdcAmount.toFixed(2)}`,
            originalUsdcAmount: `$${position.usdcAmount}`,
            slippageLoss: `$${(position.usdcAmount - actualUsdcAmount).toFixed(2)}`,
          });
        } else {
          console.log(
            `No mint details available for position ${positionId}, using original usdcAmount`,
          );
          actualUsdcAmount = position.usdcAmount;
        }
      }

      // Get original values for comparison
      let originalUsdcAmount = actualUsdcAmount; // Use actual amount as the baseline
      let originalToken0Value = null;
      let originalToken1Value = null;
      let originalToken0Amount = null;
      let originalToken1Amount = null;
      let usedMintDetails = false;
      const mintDetails = position.metadata?.mintDetails;

      if (
        mintDetails &&
        mintDetails.token0PriceAtMint !== undefined &&
        mintDetails.token1PriceAtMint !== undefined &&
        mintDetails.amount0 !== undefined &&
        mintDetails.amount1 !== undefined
      ) {
        // Use original token amounts and prices at mint
        const origAmount0Human =
          Number(mintDetails.amount0) / Math.pow(10, poolConfig.token0Decimals);
        const origAmount1Human =
          Number(mintDetails.amount1) / Math.pow(10, poolConfig.token1Decimals);
        originalToken0Value =
          origAmount0Human * Number(mintDetails.token0PriceAtMint);
        originalToken1Value =
          origAmount1Human * Number(mintDetails.token1PriceAtMint);
        originalToken0Amount = origAmount0Human;
        originalToken1Amount = origAmount1Human;
        originalUsdcAmount = originalToken0Value + originalToken1Value;
        usedMintDetails = true;
      }

      // Calculate original token mix/ratio
      let originalTokenMix = null;
      if (originalToken0Value !== null && originalToken1Value !== null) {
        const originalTotalValue = originalToken0Value + originalToken1Value;
        originalTokenMix = {
          token0Percentage:
            originalTotalValue > 0
              ? (originalToken0Value / originalTotalValue) * 100
              : 0,
          token1Percentage:
            originalTotalValue > 0
              ? (originalToken1Value / originalTotalValue) * 100
              : 0,
          token0ToToken1Ratio:
            originalToken1Amount > 0
              ? originalToken0Amount / originalToken1Amount
              : 0,
          token1ToToken0Ratio:
            originalToken0Amount > 0
              ? originalToken1Amount / originalToken0Amount
              : 0,
          dollarValueRatio:
            originalToken1Value > 0
              ? originalToken0Value / originalToken1Value
              : 0,
        };

        console.log('Original token mix calculated:', {
          token0Percentage: `${originalTokenMix.token0Percentage.toFixed(2)}%`,
          token1Percentage: `${originalTokenMix.token1Percentage.toFixed(2)}%`,
          token0ToToken1Ratio: originalTokenMix.token0ToToken1Ratio.toFixed(6),
          dollarValueRatio: originalTokenMix.dollarValueRatio.toFixed(4),
        });
      }

      // Calculate percentage change
      const percentageChange =
        originalUsdcAmount > 0
          ? ((totalCurrentDollarValue - originalUsdcAmount) /
              originalUsdcAmount) *
            100
          : 0;

      const result = {
        positionId: position.positionId,
        pool: {
          name: poolConfig.name,
          address: poolConfig.address,
          token0: poolConfig.token0,
          token1: poolConfig.token1,
          token0Name: poolConfig.token0Name,
          token1Name: poolConfig.token1Name,
          fee: poolConfig.fee,
        },
        status: position.status,
        currentTick,
        tokenAmounts: {
          token0: {
            symbol: poolConfig.token0Name,
            rawAmount: amount0.toString(),
            humanAmount: amount0Human,
            decimals: poolConfig.token0Decimals,
          },
          token1: {
            symbol: poolConfig.token1Name,
            rawAmount: amount1.toString(),
            humanAmount: amount1Human,
            decimals: poolConfig.token1Decimals,
          },
        },
        tokenPrices: {
          token0: {
            symbol: poolConfig.token0Name,
            price: token0Price,
          },
          token1: {
            symbol: poolConfig.token1Name,
            price: token1Price,
          },
        },
        dollarValues: {
          token0: token0DollarValue,
          token1: token1DollarValue,
          total: totalCurrentDollarValue,
        },
        originalValues: {
          usdcAmount: originalUsdcAmount,
          actualUsdcAmount: actualUsdcAmount,
          token0Value: originalToken0Value,
          token1Value: originalToken1Value,
          token0Amount: originalToken0Amount,
          token1Amount: originalToken1Amount,
          usedMintDetails,
        },
        performance: {
          percentageChange,
          absoluteChange: totalCurrentDollarValue - originalUsdcAmount,
          isProfitable: totalCurrentDollarValue > originalUsdcAmount,
        },
        tokenMix: {
          current: tokenMix,
          original: originalTokenMix,
        },
        metadata: {
          createdAt: (position as any).createdAt,
          updatedAt: (position as any).updatedAt,
          tickRange: position.metadata?.tickRange,
          liquidity: position.metadata?.mintDetails?.liquidity,
          collectedFees: position.collectedFees,
        },
      };

      console.log('Position details calculated:', {
        totalCurrentDollarValue: result.dollarValues.total,
        originalUsdcAmount: result.originalValues.usdcAmount,
        percentageChange: result.performance.percentageChange,
      });

      // Save the details with timestamp
      const detailsToSave = {
        timestamp: new Date().toISOString(),
        tokenAmounts: {
          token0: {
            humanAmount: result.tokenAmounts.token0.humanAmount,
          },
          token1: {
            humanAmount: result.tokenAmounts.token1.humanAmount,
          },
        },
        tokenPrices: {
          token0: {
            price: result.tokenPrices.token0.price,
          },
          token1: {
            price: result.tokenPrices.token1.price,
          },
        },
        dollarValues: result.dollarValues,
        performance: {
          absoluteChange: result.performance.absoluteChange,
          percentageChange: result.performance.percentageChange,
        },
        tokenMix: result.tokenMix,
        currentTick: currentTick,
      };

      // Update the position with the new details in a single operation
      const updateData: any = {
        $push: {
          'metadata.positionHistory': detailsToSave,
        },
      };

      // If we calculated actualUsdcAmount for the first time, save it
      if (
        actualUsdcAmount !== undefined &&
        actualUsdcAmount !== position.actualUsdcAmount
      ) {
        updateData.$set = { actualUsdcAmount };
        console.log(
          `Saving actualUsdcAmount ${actualUsdcAmount} to position ${positionId}`,
        );
      }

      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        updateData,
      );

      console.log('Position details saved to history:', {
        positionId: result.positionId,
        timestamp: detailsToSave.timestamp,
        absoluteChange: detailsToSave.performance.absoluteChange,
        percentageChange: detailsToSave.performance.percentageChange,
      });

      return result;
    } catch (error) {
      console.error(`Error getting position details for ${positionId}:`, error);
      throw new HttpException(
        error.message || 'Failed to get position details',
        error.status || 500,
      );
    }
  }

  // === WALLET QUEUE MANAGEMENT ===

  /**
   * Get the current rebalancing state for a wallet
   */
  private async getWalletRebalancingState(walletLocator: string) {
    const position = await this.aerodromePositionModel.findOne({
      walletLocator,
      'walletRebalancingQueue.isRebalancing': true,
    });
    return position?.walletRebalancingQueue;
  }

  /**
   * Check if a wallet is currently rebalancing
   */
  private async isWalletRebalancing(walletLocator: string): Promise<boolean> {
    const state = await this.getWalletRebalancingState(walletLocator);
    return !!state?.isRebalancing;
  }

  /**
   * Add a position to a wallet's rebalancing queue
   */
  private async addToWalletQueue(
    walletLocator: string,
    positionId: string,
    reason: 'out_of_range' | 'fee_optimiser',
  ) {
    console.log(
      `Adding position ${positionId} to wallet ${walletLocator} queue`,
    );

    const existingState = await this.getWalletRebalancingState(walletLocator);

    if (!existingState || !existingState.isRebalancing) {
      // Start new rebalancing for this wallet
      await this.startWalletRebalancing(walletLocator, positionId, reason);
    } else {
      // Add to existing queue
      await this.addToExistingQueue(walletLocator, positionId);
    }
  }

  /**
   * Start rebalancing for a wallet (first position in queue)
   */
  private async startWalletRebalancing(
    walletLocator: string,
    positionId: string,
    reason: 'out_of_range' | 'fee_optimiser',
  ) {
    console.log(
      `Starting rebalancing for wallet ${walletLocator}, position ${positionId}`,
    );

    // Actually start the rebalancing process FIRST
    try {
      console.log(`Starting actual rebalancing for position ${positionId}`);
      await this.performRebalance(positionId, reason);
    } catch (error) {
      console.error(
        `Failed to start rebalancing for position ${positionId}:`,
        error,
      );

      // Clear the rebalancing state on failure
      await this.clearWalletRebalancingState(walletLocator);

      throw error;
    }

    // Update the position to mark rebalancing as started (after successful start)
    await this.aerodromePositionModel.findOneAndUpdate(
      { positionId },
      {
        status: 'rebalancing',
        $set: {
          walletRebalancingQueue: {
            isRebalancing: true,
            currentPositionId: positionId,
            queuedPositions: [],
            startedAt: new Date(),
            currentReason: reason,
          },
          'metadata.rebalancingInfo': {
            reason,
            startedAt: new Date().toISOString(),
            isRebalancing: true,
          },
        },
      },
    );
  }

  /**
   * Add a position to an existing wallet queue
   */
  private async addToExistingQueue(walletLocator: string, positionId: string) {
    console.log(
      `Adding position ${positionId} to existing queue for wallet ${walletLocator}`,
    );

    await this.aerodromePositionModel.findOneAndUpdate(
      { walletLocator, 'walletRebalancingQueue.isRebalancing': true },
      {
        $push: {
          'walletRebalancingQueue.queuedPositions': positionId,
        },
      },
    );
  }

  /**
   * Process the next position in a wallet's queue
   */
  private async processNextInQueue(walletLocator: string) {
    console.log(
      `Processing next position in queue for wallet ${walletLocator}`,
    );

    const position = await this.aerodromePositionModel.findOne({
      walletLocator,
      'walletRebalancingQueue.isRebalancing': true,
    });

    if (!position?.walletRebalancingQueue) {
      console.log(`No rebalancing state found for wallet ${walletLocator}`);
      return;
    }

    const { queuedPositions } = position.walletRebalancingQueue;

    if (queuedPositions.length > 0) {
      // Get the next position from queue
      const nextPositionId = queuedPositions[0];
      const remainingPositions = queuedPositions.slice(1);

      console.log(`Starting rebalancing for next position: ${nextPositionId}`);

      // Update the queue to remove the position we're about to process
      await this.aerodromePositionModel.findOneAndUpdate(
        { walletLocator, 'walletRebalancingQueue.isRebalancing': true },
        {
          $set: {
            'walletRebalancingQueue.currentPositionId': nextPositionId,
            'walletRebalancingQueue.queuedPositions': remainingPositions,
            'walletRebalancingQueue.startedAt': new Date(),
          },
        },
      );

      // Start rebalancing the next position
      const currentReason = position.walletRebalancingQueue.currentReason;
      // Validate and convert old reason types to valid ones
      const validReason =
        currentReason === 'dollar_fees' ||
        currentReason === 'imbalanced' ||
        currentReason === 'age_limit'
          ? 'out_of_range'
          : (currentReason as 'out_of_range' | 'fee_optimiser');

      await this.performRebalance(nextPositionId, validReason);
    } else {
      // No more positions in queue, clear the rebalancing state
      await this.clearWalletRebalancingState(walletLocator);
    }
  }

  /**
   * Clear a wallet's rebalancing state
   */
  async clearWalletRebalancingState(walletLocator: string) {
    try {
      console.log(`=== Clearing Rebalancing State for ${walletLocator} ===`);

      // Update all positions for this wallet to remove rebalancing state
      const result = await this.aerodromePositionModel.updateMany(
        { walletLocator },
        {
          $unset: { walletRebalancingQueue: 1 },
        },
      );

      console.log(
        `Cleared rebalancing state for ${result.modifiedCount} positions`,
      );

      return {
        success: true,
        message: `Cleared rebalancing state for ${result.modifiedCount} positions`,
        modifiedCount: result.modifiedCount,
      };
    } catch (error) {
      console.error('Error clearing wallet rebalancing state:', error);
      throw new HttpException('Failed to clear wallet rebalancing state', 500);
    }
  }

  async deleteJunkPositions() {
    try {
      console.log('=== Deleting Junk Positions ===');

      // Find all positions with junk statuses
      const junkPositions = await this.aerodromePositionModel.find({
        status: {
          $in: [
            'retry_failed',
            'retry_completed',
            'cleanup_completed',
            'cleaning_up',
          ],
        },
      });

      console.log(`Found ${junkPositions.length} junk positions to delete`);

      if (junkPositions.length === 0) {
        return {
          success: true,
          message: 'No junk positions found to delete',
          deletedCount: 0,
          positions: [],
        };
      }

      // Delete all junk positions
      const deleteResult = await this.aerodromePositionModel.deleteMany({
        status: {
          $in: [
            'retry_failed',
            'retry_completed',
            'cleanup_completed',
            'cleaning_up',
          ],
        },
      });

      console.log(
        `Successfully deleted ${deleteResult.deletedCount} junk positions`,
      );

      return {
        success: true,
        message: `Successfully deleted ${deleteResult.deletedCount} junk positions`,
        deletedCount: deleteResult.deletedCount,
        positions: junkPositions.map((pos) => ({
          positionId: pos.positionId,
          walletLocator: pos.walletLocator,
          pool: pos.pool,
          status: pos.status,
        })),
      };
    } catch (error) {
      console.error('Error deleting junk positions:', error);
      throw new HttpException('Failed to delete junk positions', 500);
    }
  }

  /**
   * Get all wallets that are currently rebalancing
   */
  private async getRebalancingWallets(): Promise<string[]> {
    const positions = await this.aerodromePositionModel.find({
      'walletRebalancingQueue.isRebalancing': true,
    });

    // Check for stuck rebalancing states (older than 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    console.log(
      `Checking for stuck rebalancing states older than: ${thirtyMinutesAgo.toISOString()}`,
    );

    const stuckPositions = positions.filter((pos) => {
      const startedAt = pos.walletRebalancingQueue?.startedAt;
      const isStuck = startedAt && new Date(startedAt) < thirtyMinutesAgo;
      if (isStuck) {
        console.log(
          `Found stuck position for wallet ${pos.walletLocator}, started at: ${startedAt}`,
        );
      }
      return isStuck;
    });

    if (stuckPositions.length > 0) {
      console.log(
        `Found ${stuckPositions.length} stuck rebalancing states, clearing them...`,
      );

      for (const position of stuckPositions) {
        console.log(
          `Clearing stuck rebalancing state for wallet ${position.walletLocator}`,
        );
        await this.clearWalletRebalancingState(position.walletLocator);
      }
    }

    // Get the updated list after clearing stuck states
    const updatedPositions = await this.aerodromePositionModel.find({
      'walletRebalancingQueue.isRebalancing': true,
    });

    return [...new Set(updatedPositions.map((pos) => pos.walletLocator))];
  }

  /**
   * Perform the actual rebalancing operation
   */
  private async performRebalance(
    positionId: string,
    reason: 'out_of_range' | 'fee_optimiser',
  ) {
    // Add timeout protection for rebalancing operations
    const timeoutMs = 25 * 60 * 1000; // 25 minutes timeout

    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Rebalancing operation timed out after 25 minutes'));
        }, timeoutMs);
      });

      const rebalancePromise = this.rebalancePositionInternal(
        positionId,
        reason as 'out_of_range' | 'fee_optimiser',
      );

      // Race between timeout and actual rebalancing
      return await Promise.race([rebalancePromise, timeoutPromise]);
    } catch (error) {
      console.error(`Rebalancing failed for position ${positionId}:`, error);

      // Clear the rebalancing state on timeout or failure
      try {
        const position = await this.aerodromePositionModel.findOne({
          positionId,
        });
        if (position) {
          await this.clearWalletRebalancingState(position.walletLocator);
        }
      } catch (clearError) {
        console.error('Failed to clear rebalancing state:', clearError);
      }

      throw error;
    }
  }

  /**
   * Get current queue status for a wallet (for debugging)
   */
  async getWalletQueueStatus(walletLocator: string) {
    const position = await this.aerodromePositionModel.findOne({
      walletLocator,
      'walletRebalancingQueue.isRebalancing': true,
    });

    if (!position?.walletRebalancingQueue) {
      return {
        isRebalancing: false,
        message: 'No rebalancing in progress for this wallet',
      };
    }

    return {
      isRebalancing: true,
      currentPositionId: position.walletRebalancingQueue.currentPositionId,
      queuedPositions: position.walletRebalancingQueue.queuedPositions,
      startedAt: position.walletRebalancingQueue.startedAt,
      currentReason: position.walletRebalancingQueue.currentReason,
      queueLength: position.walletRebalancingQueue.queuedPositions.length,
    };
  }

  // === REBALANCING LOGIC ===
  /**
   * Test endpoint to get all positions updated in the last 6 hours and 40 minutes
   * Returns positions ordered from oldest updated to newest updated
   */
  async getPositionsUpdatedInLast6h40m(): Promise<{
    success: boolean;
    message: string;
    count: number;
    positions: any[];
    timeRange: {
      from: string;
      to: string;
      duration: string;
    };
  }> {
    try {
      console.log('=== GETTING POSITIONS UPDATED IN LAST 6h 40m ===');

      // Calculate time range: 6 hours and 40 minutes ago from now
      const now = new Date();
      const sixHoursFortyMinutesAgo = new Date(
        now.getTime() - (6 * 60 + 40) * 60 * 1000,
      );

      console.log('Time range:', {
        from: sixHoursFortyMinutesAgo.toISOString(),
        to: now.toISOString(),
        duration: '6 hours 40 minutes',
      });

      // Query positions updated in the last 6 hours and 40 minutes
      // Ordered by updatedAt ascending (oldest to newest)
      const positions = await this.aerodromePositionModel
        .find({
          updatedAt: {
            $gte: sixHoursFortyMinutesAgo,
            $lte: now,
          },
        })
        .sort({ updatedAt: 1 }) // 1 for ascending order (oldest first)
        .lean(); // Use lean() for better performance since we're just reading

      console.log(
        `Found ${positions.length} positions updated in the last 6h 40m`,
      );

      // Log the first few positions for debugging
      if (positions.length > 0) {
        console.log('First 3 positions (oldest):');
        positions.slice(0, 3).forEach((pos, index) => {
          console.log(
            `${index + 1}. Position ${pos.positionId} - Updated: ${(pos as any).updatedAt}`,
          );
        });

        if (positions.length > 3) {
          console.log('Last 3 positions (newest):');
          positions.slice(-3).forEach((pos, index) => {
            const actualIndex = positions.length - 3 + index;
            console.log(
              `${actualIndex + 1}. Position ${pos.positionId} - Updated: ${(pos as any).updatedAt}`,
            );
          });
        }
      }

      return {
        success: true,
        message: `Successfully retrieved ${positions.length} positions updated in the last 6 hours and 40 minutes`,
        count: positions.length,
        positions: positions,
        timeRange: {
          from: sixHoursFortyMinutesAgo.toISOString(),
          to: now.toISOString(),
          duration: '6 hours 40 minutes',
        },
      };
    } catch (error) {
      console.error('Error getting positions updated in last 6h 40m:', error);
      return {
        success: false,
        message: `Failed to get positions: ${error.message}`,
        count: 0,
        positions: [],
        timeRange: {
          from: '',
          to: '',
          duration: '6 hours 40 minutes',
        },
      };
    }
  }

  async comparePositionsForValueLoss(
    positionId1: string,
    positionId2: string,
  ): Promise<{
    success: boolean;
    message: string;
    olderPosition: any;
    newerPosition: any;
    valueLoss: {
      totalUSDValueLoss: number;
      token0Loss: number;
      token1Loss: number;
      percentageLoss: number;
    };
    analysis: {
      olderPositionUSDValue: number;
      newerPositionUSDValue: number;
      priceAdjustedValue: number;
      actualValue: number;
    };
  }> {
    try {
      console.log(`=== COMPARING POSITIONS FOR VALUE LOSS ===`);
      console.log(`Position 1: ${positionId1}`);
      console.log(`Position 2: ${positionId2}`);

      // Fetch both positions
      const position1 = await this.aerodromePositionModel.findOne({
        positionId: positionId1,
      });
      const position2 = await this.aerodromePositionModel.findOne({
        positionId: positionId2,
      });

      if (!position1 || !position2) {
        throw new Error('One or both positions not found');
      }

      // Determine which is older based on createdAt
      const olderPosition =
        (position1 as any).createdAt < (position2 as any).createdAt
          ? position1
          : position2;
      const newerPosition =
        (position1 as any).createdAt < (position2 as any).createdAt
          ? position2
          : position1;

      console.log('Position analysis:', {
        olderPositionId: olderPosition.positionId,
        olderCreatedAt: (olderPosition as any).createdAt,
        newerPositionId: newerPosition.positionId,
        newerCreatedAt: (newerPosition as any).createdAt,
      });

      // Check if both positions have retryMetadata
      if (
        !olderPosition.metadata?.retryMetadata?.originalTokenAmounts ||
        !newerPosition.metadata?.retryMetadata?.originalTokenAmounts
      ) {
        throw new Error(
          'Both positions must have retryMetadata with originalTokenAmounts',
        );
      }

      // Get pool config
      const poolConfig = getPoolConfig(olderPosition.pool);
      if (!poolConfig) {
        throw new Error(`Pool config not found for ${olderPosition.pool}`);
      }

      // Get the prices from the newer position's mintDetails
      const newerPositionPrices = newerPosition.metadata?.mintDetails;
      if (!newerPositionPrices) {
        throw new Error('Newer position does not have mintDetails with prices');
      }

      const token0PriceAtNewerMint = newerPositionPrices.token0PriceAtMint;
      const token1PriceAtNewerMint = newerPositionPrices.token1PriceAtMint;

      console.log('Prices from newer position mintDetails:', {
        token0PriceAtNewerMint,
        token1PriceAtNewerMint,
      });

      // Get older position's token amounts
      const olderToken0Amount = BigInt(
        olderPosition.metadata.retryMetadata.originalTokenAmounts.token0,
      );
      const olderToken1Amount = BigInt(
        olderPosition.metadata.retryMetadata.originalTokenAmounts.token1,
      );
      const olderUSDValue =
        olderPosition.metadata.retryMetadata.originalTokenAmounts.totalUSDValue;

      // Get newer position's token amounts
      const newerToken0Amount = BigInt(
        newerPosition.metadata.retryMetadata.originalTokenAmounts.token0,
      );
      const newerToken1Amount = BigInt(
        newerPosition.metadata.retryMetadata.originalTokenAmounts.token1,
      );
      const newerUSDValue =
        newerPosition.metadata.retryMetadata.originalTokenAmounts.totalUSDValue;

      // Calculate what the older amounts would be worth at the newer position's prices
      const olderToken0ValueUSD =
        (Number(olderToken0Amount) / Math.pow(10, poolConfig.token0Decimals)) *
        token0PriceAtNewerMint;
      const olderToken1ValueUSD =
        (Number(olderToken1Amount) / Math.pow(10, poolConfig.token1Decimals)) *
        token1PriceAtNewerMint;
      const priceAdjustedValue = olderToken0ValueUSD + olderToken1ValueUSD;

      // Calculate actual value of newer position
      const actualValue = newerUSDValue;

      // Calculate losses
      const totalUSDValueLoss = priceAdjustedValue - actualValue;
      const token0Loss =
        Number(olderToken0Amount - newerToken0Amount) /
        Math.pow(10, poolConfig.token0Decimals);
      const token1Loss =
        Number(olderToken1Amount - newerToken1Amount) /
        Math.pow(10, poolConfig.token1Decimals);
      const percentageLoss = (totalUSDValueLoss / priceAdjustedValue) * 100;

      console.log('Value loss calculation:', {
        olderToken0Amount: olderToken0Amount.toString(),
        olderToken1Amount: olderToken1Amount.toString(),
        newerToken0Amount: newerToken0Amount.toString(),
        newerToken1Amount: newerToken1Amount.toString(),
        priceAdjustedValue: priceAdjustedValue.toFixed(6),
        actualValue: actualValue.toFixed(6),
        totalUSDValueLoss: totalUSDValueLoss.toFixed(6),
        percentageLoss: percentageLoss.toFixed(4),
      });

      return {
        success: true,
        message: 'Position comparison completed successfully',
        olderPosition: {
          positionId: olderPosition.positionId,
          createdAt: (olderPosition as any).createdAt,
          status: olderPosition.status,
          pool: olderPosition.pool,
        },
        newerPosition: {
          positionId: newerPosition.positionId,
          createdAt: (newerPosition as any).createdAt,
          status: newerPosition.status,
          pool: newerPosition.pool,
        },
        valueLoss: {
          totalUSDValueLoss: Number(totalUSDValueLoss.toFixed(6)),
          token0Loss: Number(token0Loss.toFixed(8)),
          token1Loss: Number(token1Loss.toFixed(6)),
          percentageLoss: Number(percentageLoss.toFixed(4)),
        },
        analysis: {
          olderPositionUSDValue: Number(olderUSDValue.toFixed(6)),
          newerPositionUSDValue: Number(newerUSDValue.toFixed(6)),
          priceAdjustedValue: Number(priceAdjustedValue.toFixed(6)),
          actualValue: Number(actualValue.toFixed(6)),
        },
      };
    } catch (error) {
      console.error('Error comparing positions for value loss:', error);
      return {
        success: false,
        message: `Error comparing positions: ${error.message}`,
        olderPosition: null,
        newerPosition: null,
        valueLoss: {
          totalUSDValueLoss: 0,
          token0Loss: 0,
          token1Loss: 0,
          percentageLoss: 0,
        },
        analysis: {
          olderPositionUSDValue: 0,
          newerPositionUSDValue: 0,
          priceAdjustedValue: 0,
          actualValue: 0,
        },
      };
    }
  }

  // === DAILY FEE STATISTICS METHODS ===

  async getDailyFeesStats(date?: string) {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];

      const dailyFees = await this.dailyFeesModel.findOne({ date: targetDate });

      if (!dailyFees) {
        return {
          success: true,
          message: `No fee data found for ${targetDate}`,
          date: targetDate,
          stats: {
            totalUsdValue: 0,
            totalPositions: 0,
            totalCollections: 0,
            positionFees: {},
            tokenTotals: {},
          },
        };
      }

      return {
        success: true,
        message: `Daily fee statistics for ${targetDate}`,
        date: targetDate,
        stats: {
          totalUsdValue: dailyFees.totalUsdValue,
          totalPositions: dailyFees.totalPositions,
          totalCollections: dailyFees.totalCollections,
          positionFees: dailyFees.positionFees,
          tokenTotals: dailyFees.tokenTotals,
        },
      };
    } catch (error) {
      console.error('Error getting daily fees stats:', error);
      return {
        success: false,
        message: `Error getting daily fees stats: ${error.message}`,
        date: date || new Date().toISOString().split('T')[0],
        stats: null,
      };
    }
  }

  async getDailyFeesRange(startDate: string, endDate: string) {
    try {
      const dailyFees = await this.dailyFeesModel
        .find({
          date: { $gte: startDate, $lte: endDate },
        })
        .sort({ date: 1 });

      const totalStats = {
        totalUsdValue: 0,
        totalPositions: 0,
        totalCollections: 0,
        tokenTotals: {} as any,
        dailyBreakdown: [] as any[],
      };

      for (const day of dailyFees) {
        totalStats.totalUsdValue += day.totalUsdValue;
        totalStats.totalPositions += day.totalPositions;
        totalStats.totalCollections += day.totalCollections;

        // Aggregate token totals
        for (const [tokenAddress, tokenData] of Object.entries(
          day.tokenTotals,
        )) {
          if (!totalStats.tokenTotals[tokenAddress]) {
            totalStats.tokenTotals[tokenAddress] = {
              symbol: tokenData.symbol,
              amount: '0',
              usdValue: 0,
            };
          }
          totalStats.tokenTotals[tokenAddress].amount = (
            BigInt(totalStats.tokenTotals[tokenAddress].amount) +
            BigInt(tokenData.amount)
          ).toString();
          totalStats.tokenTotals[tokenAddress].usdValue += tokenData.usdValue;
        }

        totalStats.dailyBreakdown.push({
          date: day.date,
          totalUsdValue: day.totalUsdValue,
          totalPositions: day.totalPositions,
          totalCollections: day.totalCollections,
          tokenTotals: day.tokenTotals,
        });
      }

      return {
        success: true,
        message: `Fee statistics for range ${startDate} to ${endDate}`,
        dateRange: { startDate, endDate },
        totalStats,
        dailyBreakdown: totalStats.dailyBreakdown,
      };
    } catch (error) {
      console.error('Error getting daily fees range:', error);
      return {
        success: false,
        message: `Error getting daily fees range: ${error.message}`,
        dateRange: { startDate, endDate },
        totalStats: null,
        dailyBreakdown: [],
      };
    }
  }

  async getTopEarningPositions(date?: string, limit: number = 10) {
    try {
      const targetDate = date || new Date().toISOString().split('T')[0];

      const dailyFees = await this.dailyFeesModel.findOne({ date: targetDate });

      if (!dailyFees || Object.keys(dailyFees.positionFees).length === 0) {
        return {
          success: true,
          message: `No position fee data found for ${targetDate}`,
          date: targetDate,
          topPositions: [],
        };
      }

      // Convert position fees to array and sort by USD value
      const positionArray = Object.entries(dailyFees.positionFees)
        .map(([positionId, data]) => ({
          positionId,
          ...data,
        }))
        .sort((a, b) => b.usdValue - a.usdValue)
        .slice(0, limit);

      return {
        success: true,
        message: `Top ${limit} earning positions for ${targetDate}`,
        date: targetDate,
        topPositions: positionArray,
      };
    } catch (error) {
      console.error('Error getting top earning positions:', error);
      return {
        success: false,
        message: `Error getting top earning positions: ${error.message}`,
        date: date || new Date().toISOString().split('T')[0],
        topPositions: [],
      };
    }
  }

  /**
   * Emergency function to burn all positions for a given wallet address
   * No database calls - direct blockchain operations only
   * @param walletAddress The wallet address to burn all positions for
   * @returns Array of burn results for each position
   */
  async emergencyBurnAllPositions(
    walletAddress: string,
    tokenId?: string,
  ): Promise<{
    success: boolean;
    message: string;
    results: Array<{
      tokenId: string;
      success: boolean;
      error?: string;
      burnResult?: any;
    }>;
  }> {
    try {
      if (tokenId) {
        console.log(
          `=== EMERGENCY BURN SPECIFIC POSITION ${tokenId} FOR ${walletAddress} ===`,
        );
      } else {
        console.log(
          `=== EMERGENCY BURN ALL POSITIONS FOR ${walletAddress} ===`,
        );
      }

      // Get wallet locator from address (assuming walletAddress is the locator)
      const walletLocator = walletAddress;
      const actualWalletAddress =
        this.getWalletAddressFromLocator(walletLocator);

      let positionIds: string[];

      if (tokenId) {
        // If tokenId is provided, only burn that specific position
        positionIds = [tokenId];
        console.log(`Burning specific position: ${tokenId}`);
      } else {
        // Get all positions for this wallet from the NonFungiblePositionManager
        positionIds =
          await this.getAllPositionIdsForWallet(actualWalletAddress);

        if (positionIds.length === 0) {
          return {
            success: true,
            message: `No positions found for wallet ${actualWalletAddress}`,
            results: [],
          };
        }

        console.log(`Found ${positionIds.length} positions to burn`);
      }

      const results = [];

      for (const tokenId of positionIds) {
        try {
          console.log(`Burning position with tokenId: ${tokenId}`);

          // Step 1: Get current liquidity from the position
          console.log(`Getting current liquidity for tokenId: ${tokenId}`);
          const onChainPositionRaw = await this.readContract(
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'positions',
            [tokenId],
          );
          const { decodeFunctionResult } = await import('viem');
          const decoded = decodeFunctionResult({
            abi: NonFungiblePositionManagerAbi as any,
            functionName: 'positions',
            data: onChainPositionRaw,
          });
          const liquidity = BigInt(decoded[7]);

          console.log(
            `Current liquidity for ${tokenId}:`,
            liquidity.toString(),
          );

          if (!liquidity || liquidity === 0n) {
            // If liquidity is already 0, still need to collect any withdrawable tokens before burning
            console.log(
              `Position ${tokenId} has zero liquidity, collecting withdrawable tokens before burning`,
            );

            // Step 3: Collect any withdrawable tokens (even with zero liquidity)
            console.log(
              `Collecting withdrawable tokens for tokenId: ${tokenId}`,
            );
            const MAX_UINT128 = 2n ** 128n - 1n;
            const collectFeesResult = await this.sendTransaction(
              walletLocator,
              this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
              NonFungiblePositionManagerAbi as unknown as any[],
              'collect',
              [
                {
                  tokenId: BigInt(tokenId),
                  recipient: actualWalletAddress,
                  amount0Max: MAX_UINT128,
                  amount1Max: MAX_UINT128,
                },
              ],
            );
            console.log(
              `Collect fees result for ${tokenId}:`,
              collectFeesResult,
            );

            // Step 4: Burn the position (destroy the NFT)
            console.log(`Burning position with tokenId: ${tokenId}`);
            const burnResult = await this.sendTransaction(
              walletLocator,
              this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
              NonFungiblePositionManagerAbi as unknown as any[],
              'burn',
              [BigInt(tokenId)],
            );
            console.log(`Burn result for ${tokenId}:`, burnResult);

            results.push({
              tokenId,
              success: true,
              burnResult: {
                liquidity: '0',
                collectFeesResult,
                burnResult,
              },
            });
            continue;
          }

          // Step 2: Decrease liquidity by the actual amount
          console.log(
            `Decreasing liquidity by ${liquidity.toString()} for tokenId: ${tokenId}`,
          );
          const decreaseParams = {
            tokenId: BigInt(tokenId),
            liquidity: BigInt(liquidity),
            amount0Min: 0,
            amount1Min: 0,
            deadline: Math.floor(Date.now() / 1000) + 1800,
          };

          const decreaseLiquidityResult = await this.sendTransaction(
            walletLocator,
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'decreaseLiquidity',
            [decreaseParams],
          );
          console.log(
            `Decrease liquidity result for ${tokenId}:`,
            decreaseLiquidityResult,
          );

          // Step 3: Collect fees (receive the tokens)
          console.log(`Collecting fees for tokenId: ${tokenId}`);
          const MAX_UINT128 = 2n ** 128n - 1n;
          const collectFeesResult = await this.sendTransaction(
            walletLocator,
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'collect',
            [
              {
                tokenId: BigInt(tokenId),
                recipient: actualWalletAddress,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
              },
            ],
          );
          console.log(`Collect fees result for ${tokenId}:`, collectFeesResult);

          // Step 4: Burn the position (destroy the NFT)
          console.log(`Burning position with tokenId: ${tokenId}`);
          const burnResult = await this.sendTransaction(
            walletLocator,
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'burn',
            [BigInt(tokenId)],
          );
          console.log(`Burn result for ${tokenId}:`, burnResult);

          results.push({
            tokenId,
            success: true,
            burnResult: {
              liquidity: liquidity.toString(),
              decreaseLiquidityResult,
              collectFeesResult,
              burnResult,
            },
          });

          console.log(`✅ Successfully burned position ${tokenId}`);
        } catch (error) {
          console.error(`❌ Failed to burn position ${tokenId}:`, error);
          results.push({
            tokenId,
            success: false,
            error: error.message,
          });
        }
      }

      const successfulBurns = results.filter((r) => r.success).length;
      const failedBurns = results.filter((r) => !r.success).length;

      console.log(`=== EMERGENCY BURN COMPLETED ===`);
      console.log(`Successful burns: ${successfulBurns}`);
      console.log(`Failed burns: ${failedBurns}`);
      console.log(`Total positions: ${positionIds.length}`);

      return {
        success: failedBurns === 0,
        message: `Emergency burn completed. ${successfulBurns} successful, ${failedBurns} failed out of ${positionIds.length} total positions.`,
        results,
      };
    } catch (error) {
      console.error('Emergency burn failed:', error);
      return {
        success: false,
        message: `Emergency burn failed: ${error.message}`,
        results: [],
      };
    }
  }

  /**
   * Get all position token IDs for a given wallet address
   * @param walletAddress The wallet address
   * @returns Array of token IDs
   */
  /**
   * Check if a transaction hash exists on-chain
   * @param transactionHash The transaction hash to check
   * @returns boolean indicating if transaction exists
   */
  private async checkTransactionExists(
    transactionHash: string,
  ): Promise<boolean> {
    try {
      const alchemyApiKey = this.configService.get<string>(
        'ALCHEMY_API_KEY_BASE',
      );
      if (!alchemyApiKey) {
        console.warn(
          'ALCHEMY_API_KEY_BASE not configured, skipping transaction check',
        );
        return false;
      }

      const { createPublicClient, http } = await import('viem');
      const publicClient = createPublicClient({
        transport: http(
          `https://base-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
        ),
        chain: base,
      });

      const receipt = await publicClient.getTransactionReceipt({
        hash: transactionHash as `0x${string}`,
      });

      return !!receipt;
    } catch (error) {
      console.warn(
        `Failed to check transaction ${transactionHash}:`,
        error.message,
      );
      return false;
    }
  }

  private async getAllPositionIdsForWallet(
    walletAddress: string,
  ): Promise<string[]> {
    try {
      console.log(`Getting all position IDs for wallet: ${walletAddress}`);

      // Get balance of positions for this wallet
      const balanceResult = await this.readContract(
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'balanceOf',
        [walletAddress],
      );

      const balance = Number(balanceResult);
      console.log(`Wallet has ${balance} positions`);

      if (balance === 0) {
        return [];
      }

      const tokenIds: string[] = [];

      // Get each token ID by index
      for (let i = 0; i < balance; i++) {
        try {
          const tokenIdResult = await this.readContract(
            this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
            NonFungiblePositionManagerAbi as unknown as any[],
            'tokenOfOwnerByIndex',
            [walletAddress, i],
          );

          const tokenId = tokenIdResult.toString();
          tokenIds.push(tokenId);
          console.log(`Found token ID: ${tokenId}`);
        } catch (error) {
          console.error(`Error getting token ID at index ${i}:`, error);
        }
      }

      console.log(`Retrieved ${tokenIds.length} token IDs`);
      return tokenIds;
    } catch (error) {
      console.error('Error getting position IDs:', error);
      throw error;
    }
  }

  /**
   * Validates that calculated amounts (collected fees + unused amounts) match actual wallet balances
   * This helps detect discrepancies in position tracking and calculation logic
   */
  private async validateCalculatedAmountsAgainstBalances(
    positions: any[],
  ): Promise<void> {
    try {
      console.log('=== VALIDATING CALCULATED AMOUNTS AGAINST BALANCES ===');

      // Group positions by wallet
      const walletPositions = new Map<string, any[]>();
      for (const position of positions) {
        const walletLocator = position.walletLocator;
        if (!walletPositions.has(walletLocator)) {
          walletPositions.set(walletLocator, []);
        }
        walletPositions.get(walletLocator)!.push(position);
      }

      for (const [walletLocator, walletPositionsList] of walletPositions) {
        try {
          const walletAddress = this.getWalletAddressFromLocator(walletLocator);
          console.log(`Validating wallet: ${walletAddress}`);

          // Get actual wallet balances
          const [token0BalanceResult, token1BalanceResult] = await Promise.all([
            this.readContract(
              '0x4200000000000000000000000000000000000006', // WETH
              ERC20_ABI as unknown as any[],
              'balanceOf',
              [walletAddress],
            ),
            this.readContract(
              '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
              ERC20_ABI as unknown as any[],
              'balanceOf',
              [walletAddress],
            ),
          ]);

          // Decode the balance results (they come as hex strings)
          const actualToken0Balance = BigInt(token0BalanceResult || '0x0');
          const actualToken1Balance = BigInt(token1BalanceResult || '0x0');

          // Calculate expected amounts from all positions for this wallet
          let expectedToken0Total = 0n;
          let expectedToken1Total = 0n;

          for (const position of walletPositionsList) {
            // Calculate expected amounts: unused amounts + collected fees
            const amount0Unused = BigInt(
              position.metadata?.mintDetails?.amount0Unused || '0',
            );
            const amount1Unused = BigInt(
              position.metadata?.mintDetails?.amount1Unused || '0',
            );
            const collectedFeesToken0 = BigInt(
              position.collectedFees?.token0 || '0',
            );
            const collectedFeesToken1 = BigInt(
              position.collectedFees?.token1 || '0',
            );
            console.log('collectedFeesToken0', collectedFeesToken0);
            console.log('collectedFeesToken1', collectedFeesToken1);
            expectedToken0Total += amount0Unused + collectedFeesToken0;
            expectedToken1Total += amount1Unused + collectedFeesToken1;

            // Log individual position breakdown for debugging
            console.log(`Position ${position.positionId} breakdown:`, {
              amount0Unused: amount0Unused.toString(),
              collectedFeesToken0: collectedFeesToken0.toString(),
              amount1Unused: amount1Unused.toString(),
              collectedFeesToken1: collectedFeesToken1.toString(),
            });
          }

          // Compare expected vs actual
          const token0Difference = expectedToken0Total - actualToken0Balance;
          const token1Difference = expectedToken1Total - actualToken1Balance;

          const token0DifferencePercent =
            expectedToken0Total > 0
              ? Number((token0Difference * 10000n) / expectedToken0Total) / 100
              : 0;
          const token1DifferencePercent =
            expectedToken1Total > 0
              ? Number((token1Difference * 10000n) / expectedToken1Total) / 100
              : 0;

          // Log validation results
          const validationResult = {
            walletAddress,
            positions: walletPositionsList.length,
            expected: {
              token0: expectedToken0Total.toString(),
              token1: expectedToken1Total.toString(),
            },
            actual: {
              token0: actualToken0Balance.toString(),
              token1: actualToken1Balance.toString(),
            },
            difference: {
              token0: token0Difference.toString(),
              token1: token1Difference.toString(),
            },
            differencePercent: {
              token0: token0DifferencePercent,
              token1: token1DifferencePercent,
            },
            status: {
              token0:
                Math.abs(token0DifferencePercent) <= 1 ? 'OK' : 'DISCREPANCY',
              token1:
                Math.abs(token1DifferencePercent) <= 1 ? 'OK' : 'DISCREPANCY',
            },
          };

          console.log('Validation result:', validationResult);

          // Log warning only for positive discrepancies (actual < expected)
          if (token0DifferencePercent > 1 || token1DifferencePercent > 1) {
            console.warn('⚠️ SIGNIFICANT POSITIVE DISCREPANCY DETECTED:', {
              walletAddress,
              token0Discrepancy: `${token0DifferencePercent}%`,
              token1Discrepancy: `${token1DifferencePercent}%`,
              expectedToken0: expectedToken0Total.toString(),
              actualToken0: actualToken0Balance.toString(),
              expectedToken1: expectedToken1Total.toString(),
              actualToken1: actualToken1Balance.toString(),
              note: 'Actual balance is lower than expected - investigate potential fund loss',
            });
          } else if (
            token0DifferencePercent < -1 ||
            token1DifferencePercent < -1
          ) {
            console.log('ℹ️ NEGATIVE DISCREPANCY (OK):', {
              walletAddress,
              token0Discrepancy: `${token0DifferencePercent}%`,
              token1Discrepancy: `${token1DifferencePercent}%`,
              note: 'Actual balance is higher than expected - likely from other sources',
            });
          }
        } catch (error) {
          console.error(`Error validating wallet ${walletLocator}:`, error);
        }
      }

      console.log('=== VALIDATION COMPLETE ===');
    } catch (error) {
      console.error('Error in validation:', error);
    }
  }

  /**
   * Convert human-readable amount to raw amount with proper decimals
   */
  private parseHumanAmount(amount: string, tokenAddress: string): string {
    // Common token decimals mapping for Base network
    const tokenDecimals: { [key: string]: number } = {
      // USDC on Base
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 6,
      // WETH on Base
      '0x4200000000000000000000000000000000000006': 18,
      // Common stablecoins
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': 6, // DAI on Base
      '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9': 6, // USDT on Base
    };

    // Extract amount and token symbol from string like "0.5 ETH" or "100 USDC"
    const amountMatch = amount.match(/^([\d.]+)\s*([A-Za-z]+)?$/);
    if (!amountMatch) {
      throw new Error(
        `Invalid amount format: ${amount}. Expected format: "0.5 ETH" or "100 USDC" or just "0.5"`,
      );
    }

    const numericAmount = parseFloat(amountMatch[1]);
    const tokenSymbol = amountMatch[2]?.toUpperCase();

    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new Error(`Invalid numeric amount: ${amountMatch[1]}`);
    }

    // Determine decimals based on token symbol or address
    let decimals = 18; // Default to 18 decimals

    if (tokenSymbol) {
      // Map common symbols to decimals
      const symbolDecimals: { [key: string]: number } = {
        USDC: 6,
        USDT: 6,
        DAI: 18,
        WETH: 18,
        ETH: 18,
        WBTC: 8,
        BTC: 8,
      };
      decimals = symbolDecimals[tokenSymbol] || 18;
    } else {
      // Use address-based decimals
      decimals = tokenDecimals[tokenAddress.toLowerCase()] || 18;
    }

    // Convert to raw amount
    const rawAmount = BigInt(
      Math.floor(numericAmount * Math.pow(10, decimals)),
    );
    return rawAmount.toString();
  }

  /**
   * Manual token swap using only 0x API
   */
  async manualSwap(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    slippagePercent: number = 0.3,
  ): Promise<{
    success: boolean;
    message: string;
    transactionHash?: string;
    buyAmount?: string;
    expectedBuyAmount?: string;
    minBuyAmount?: string;
    gasUsed?: string;
    gasPrice?: string;
    totalCost?: string;
  }> {
    console.log('=== MANUAL SWAP REQUEST ===');
    console.log('Parameters:', {
      walletLocator,
      sellToken,
      buyToken,
      sellAmount,
      slippagePercent,
    });

    try {
      const walletAddress = this.getWalletAddressFromLocator(walletLocator);

      // Validate that sell and buy tokens are different
      if (sellToken.toLowerCase() === buyToken.toLowerCase()) {
        throw new Error('Cannot swap token for itself');
      }

      // Parse human-readable amount to raw amount
      const rawSellAmount = this.parseHumanAmount(sellAmount, sellToken);
      console.log(`Parsed amount: ${sellAmount} -> ${rawSellAmount} (raw)`);

      // Validate sell amount
      const sellAmountBigInt = BigInt(rawSellAmount);
      if (sellAmountBigInt <= 0n) {
        throw new Error('Sell amount must be greater than 0');
      }

      // Check sell token balance
      const sellTokenBalance = await this.readContract(
        sellToken,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );

      const { decodeFunctionResult } = await import('viem');
      const decodedSellTokenBalance = decodeFunctionResult({
        abi: ERC20_ABI as any,
        functionName: 'balanceOf',
        data: sellTokenBalance,
      });

      if (BigInt(decodedSellTokenBalance.toString()) < sellAmountBigInt) {
        throw new Error(
          `Insufficient balance. Required: ${rawSellAmount} (${sellAmount}), Available: ${decodedSellTokenBalance.toString()}`,
        );
      }

      // Get 0x price quote
      const priceQuote = await this.get0xPrice(
        sellToken,
        buyToken,
        rawSellAmount,
        walletAddress,
      );

      // Get 0x swap quote
      const swapQuote = await this.get0xQuote(
        sellToken,
        buyToken,
        rawSellAmount,
        walletAddress,
      );

      // Handle token approval if needed
      if (priceQuote.issues?.allowance) {
        console.log('Approving token for 0x spender...');
        await this.handleTokenApproval(
          walletLocator,
          sellToken,
          priceQuote.issues.allowance.spender,
          sellAmountBigInt,
        );
      }

      // Execute the swap
      console.log('Executing 0x swap transaction...');
      const txResult = await this.sendRawTransaction(
        walletLocator,
        swapQuote.transaction.to,
        swapQuote.transaction.data,
        swapQuote.transaction.value || '0',
      );

      if (txResult?.status !== 'success') {
        throw new Error(`Transaction failed with status: ${txResult?.status}`);
      }

      // Wait for transaction to be processed
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get the actual buy amount from Transfer events
      const buyBalanceChange = await this.getBuyAmountFromTransferEvents(
        txResult.transactionHash,
        buyToken,
        walletAddress,
      );

      // Verify the swap was successful
      const expectedMinBuyAmount = BigInt(swapQuote.minBuyAmount);
      const buyAmountCheck = buyBalanceChange >= expectedMinBuyAmount;

      if (!buyAmountCheck) {
        const shortfall = expectedMinBuyAmount - buyBalanceChange;
        const shortfallPercentage =
          Number((shortfall * 10000n) / expectedMinBuyAmount) / 100;

        console.warn(
          'Swap completed but received less than minimum expected amount:',
          {
            expectedMin: expectedMinBuyAmount.toString(),
            received: buyBalanceChange.toString(),
            shortfall: shortfall.toString(),
            shortfallPercentage: `${shortfallPercentage}%`,
          },
        );
      }

      // Calculate gas costs (using estimated values from quote)
      const gasUsed = swapQuote.transaction.gas || '0';
      const gasPrice = swapQuote.transaction.gasPrice || '0';
      const totalGasCost = BigInt(gasUsed) * BigInt(gasPrice);

      return {
        success: true,
        message: 'Swap completed successfully',
        transactionHash: txResult.transactionHash,
        buyAmount: buyBalanceChange.toString(),
        expectedBuyAmount: swapQuote.buyAmount,
        minBuyAmount: swapQuote.minBuyAmount,
        gasUsed,
        gasPrice,
        totalCost: totalGasCost.toString(),
      };
    } catch (error) {
      console.error('Manual swap failed:', error);
      return {
        success: false,
        message: error.message || 'Swap failed',
      };
    }
  }
}
