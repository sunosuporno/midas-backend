import { Injectable, HttpException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { CreateAerodromeLpDto } from './dto/create-aerodrome-lp.dto';
import {
  AerodromePosition,
  AerodromePositionDocument,
} from './schemas/aerodrome-position.schema';
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

  constructor(
    @InjectModel(AerodromePosition.name)
    private aerodromePositionModel: Model<AerodromePositionDocument>,
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
    slippage: number = 1,
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

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        '0x-api-key': apiKey,
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

  private async get0xPrice(
    sellToken: string,
    buyToken: string,
    sellAmount: string,
    walletAddress: string,
    slippageBps: number = 100, // 1% default slippage
  ) {
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
    slippageBps: number = 100,
  ) {
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

    // Step 1: Create the transaction
    console.log('Step 1: Creating transaction...');
    const createResponse = await axios.post(
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
      const approveResponse = await axios.post(
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
      );

      status = approveResponse.data.status;
    }

    // Step 4: Poll for completion
    console.log('Step 4: Polling for transaction completion...');
    let finalStatus = status;
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max wait time

    while (
      attempts < maxAttempts &&
      (finalStatus === 'pending' || finalStatus === 'awaiting-approval')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second

      try {
        const statusResponse = await axios.get(
          `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/transactions/${transactionId}`,
          {
            headers: {
              'X-API-KEY': apiKey,
              'Content-Type': 'application/json',
            },
          },
        );

        finalStatus = statusResponse.data.status;
        console.log(`Poll attempt ${attempts + 1}: Status = ${finalStatus}`);

        if (finalStatus === 'completed' || finalStatus === 'success') {
          console.log('Transaction completed successfully!');
          return {
            id: transactionId,
            status: finalStatus,
            transactionHash:
              statusResponse.data.onChain?.txId ||
              statusResponse.data.transactionHash,
          };
        }
      } catch (error) {
        console.error(`Error polling transaction status:`, error);
      }

      attempts++;
    }

    // Return final status even if not completed
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

  async mint(createAerodromeLpDto: CreateAerodromeLpDto) {
    let positionId = null;
    let position = null;
    let swapResults = null;
    let amount0Used = null;
    let amount1Used = null;

    console.log('=== Creating Aerodrome LP Position ===');
    console.log('Wallet Locator:', createAerodromeLpDto.walletLocator);
    console.log('USDC Amount:', createAerodromeLpDto.usdcAmount);
    console.log('Pool:', createAerodromeLpDto.pool);

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

        if (token0BalanceBigInt < requiredToken0Amount) {
          throw new HttpException(
            `Insufficient ${poolConfig.token0Name} balance for retry. Required: ${requiredToken0Amount}, Available: ${token0BalanceBigInt}`,
            400,
          );
        }

        if (token1BalanceBigInt < requiredToken1Amount) {
          throw new HttpException(
            `Insufficient ${poolConfig.token1Name} balance for retry. Required: ${requiredToken1Amount}, Available: ${token1BalanceBigInt}`,
            400,
          );
        }
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
      );

      console.log('Calculated tick range for LP:', tickRange);

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

        // Use fixed slippage of 1% (100 bps)
        const slippageBps = 100;
        console.log('Using slippage (bps):', slippageBps);

        // Step 1: Check if token0 needs USDC swap
        let token0SwapResult = null;
        if (poolConfig.token0 !== this.USDC_ADDRESS) {
          // Calculate the required USDC sell amount for token0
          const token0Price = await this.getTokenPrice(poolConfig.token0Name);
          const token0AmountHuman =
            Number(liquidityAmounts.usedAmounts.token0.rawAmount) /
            Math.pow(10, poolConfig.token0Decimals);
          const sellAmountUSDC = Math.ceil(
            token0AmountHuman * token0Price * Math.pow(10, this.USDC_DECIMALS),
          );
          // Use the new swapTokens helper
          const { txResult } = await this.swapTokens(
            createAerodromeLpDto.walletLocator,
            this.USDC_ADDRESS,
            poolConfig.token0,
            sellAmountUSDC.toString(),
            slippageBps,
          );
          token0SwapResult = txResult;
        } else {
          console.log('Token0 is USDC, no swap needed');
        }

        // Step 4: Check if token1 needs USDC swap
        let token1SwapResult = null;
        if (poolConfig.token1 !== this.USDC_ADDRESS) {
          const token1Price = await this.getTokenPrice(poolConfig.token1Name);
          const token1AmountHuman =
            Number(liquidityAmounts.usedAmounts.token1.rawAmount) /
            Math.pow(10, poolConfig.token1Decimals);
          const sellAmountUSDC = Math.ceil(
            token1AmountHuman * token1Price * Math.pow(10, this.USDC_DECIMALS),
          );
          const { txResult } = await this.swapTokens(
            createAerodromeLpDto.walletLocator,
            this.USDC_ADDRESS,
            poolConfig.token1,
            sellAmountUSDC.toString(),
            slippageBps,
          );
          token1SwapResult = txResult;
        } else {
          console.log('Token1 is USDC, no swap needed');
        }

        // Store swap results for normal mode
        swapResults = {
          token0Swap: token0SwapResult
            ? {
                transactionHash: token0SwapResult.transactionHash,
                status: token0SwapResult.status,
              }
            : null,
          token1Swap: token1SwapResult
            ? {
                transactionHash: token1SwapResult.transactionHash,
                status: token1SwapResult.status,
              }
            : null,
        };

        // Set amounts used for normal mode
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
      let approveAmount0 = BigInt(
        liquidityAmounts.usedAmounts.token0.rawAmount,
      );
      console.log('approveAmount0', approveAmount0);
      const token0BalanceRaw = await this.readContract(
        poolConfig.token0,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      //decode tokenbalance
      const token0Balance = BigInt(token0BalanceRaw);
      if (token0Balance < approveAmount0) {
        const onePercent = approveAmount0 / 100n;
        if (token0Balance >= approveAmount0 - onePercent) {
          console.log(
            'Token0 balance is within 1% of required amount, approving available balance',
          );
          approveAmount0 = token0Balance;
        } else {
          throw new HttpException(
            `Insufficient token0 balance for mint: required ${approveAmount0}, available ${token0Balance}`,
            400,
          );
        }
      }

      await this.handleTokenApproval(
        createAerodromeLpDto.walletLocator,
        poolConfig.token0,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        approveAmount0,
      );
      // Check and approve token1
      console.log('Approving token1 for NonFungiblePositionManager');
      let approveAmount1 = BigInt(
        liquidityAmounts.usedAmounts.token1.rawAmount,
      );
      const token1BalanceRaw = await this.readContract(
        poolConfig.token1,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token1Balance = BigInt(token1BalanceRaw);
      if (token1Balance < approveAmount1) {
        const onePercent = approveAmount1 / 100n;
        if (token1Balance >= approveAmount1 - onePercent) {
          console.log(
            'Token1 balance is within 1% of required amount, approving available balance',
          );
          approveAmount1 = token1Balance;
        } else {
          throw new HttpException(
            `Insufficient token1 balance for mint: required ${approveAmount1}, available ${token1Balance}`,
            400,
          );
        }
      }

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

      // Call the mint function with retry logic for different slippage levels
      let mintResult = null;
      let finalSlippageUsed = 1.0; // Track which slippage was successful
      const slippageLevels = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]; // 1%, 1.5%, 2%, 2.5%, 3%, 3.5%, 4%, 4.5%, 5%

      for (const slippagePercent of slippageLevels) {
        try {
          console.log(`Attempting mint with ${slippagePercent}% slippage...`);

          // Calculate minimum amounts based on slippage
          // For 1% slippage: (100 - 1) / 100 = 0.99, so we want 99% of the amount
          // For 2% slippage: (100 - 2) / 100 = 0.98, so we want 98% of the amount
          const slippageMultiplier = (100 - slippagePercent) / 100;
          // Use higher precision to avoid integer division issues
          const amount0Min =
            (amount0Used * BigInt(Math.floor(slippageMultiplier * 10000))) /
            10000n;
          const amount1Min =
            (amount1Used * BigInt(Math.floor(slippageMultiplier * 10000))) /
            10000n;

          const mintParams = {
            ...baseMintParams,
            amount0Min: amount0Min.toString(),
            amount1Min: amount1Min.toString(),
          };

          console.log('Mint params with slippage:', {
            amount0Desired: amount0Used.toString(),
            amount1Desired: amount1Used.toString(),
            amount0Min: amount0Min.toString(),
            amount1Min: amount1Min.toString(),
            slippagePercent,
            slippageMultiplier,
            slippageMultiplierTimes10000: Math.floor(
              slippageMultiplier * 10000,
            ),
          });

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
            finalSlippageUsed = slippagePercent;
            console.log(
              `Mint successful with ${slippagePercent}% slippage:`,
              mintResult,
            );
            break; // Success, exit the retry loop
          } else {
            // Transaction was sent but failed on-chain
            throw new Error(
              `Transaction failed with status: ${mintResult.status}`,
            );
          }
        } catch (mintError) {
          console.error(
            `Mint failed with ${slippagePercent}% slippage:`,
            mintError,
          );

          // If this is the last attempt (5.0%), handle mint failure
          if (slippagePercent === 5.0) {
            console.error('All mint attempts failed. Initiating cleanup...');

            throw new HttpException(
              'Mint failed due to high slippage. Position will be cleaned up and retried later.',
              400,
            );
          }

          // Continue to next slippage level
          console.log(
            `Retrying with ${slippageLevels[slippageLevels.indexOf(slippagePercent) + 1]}% slippage...`,
          );
        }
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

      // Extract important details from mintResult
      const {
        tokenId,
        liquidity,
        amount0,
        amount1,
        transactionHash: mintTxHash,
      } = mintResult || {};

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
            finalSlippageUsed: finalSlippageUsed,
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
          finalSlippageUsed: finalSlippageUsed,
        },
      };
    } catch (error) {
      console.error('Error in Aerodrome mint:', error);

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

  async getSwapQuote(
    walletLocator: string,
    pool: string,
    usdcAmount: number,
    slippageBps: number = 100,
  ) {
    try {
      console.log('=== Getting Swap Quote ===');
      console.log('Wallet Locator:', walletLocator);
      console.log('Pool:', pool);
      console.log('USDC Amount:', usdcAmount);
      console.log('Slippage (bps):', slippageBps);

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
          slippageBps,
        );

        if (poolConfig.token0 !== poolConfig.token1) {
          token1Price = await this.get0xPrice(
            poolConfig.token1, // USDC
            poolConfig.token1, // Second token in pool
            usdcAmountInBaseUnits,
            walletAddress,
            slippageBps,
          );
        }
        quoteSource = '0x';
      } catch (oxError) {
        console.error('0x quotes failed, trying 1inch:', oxError);

        try {
          // Fall back to 1inch
          console.log('Getting quotes from 1inch...');
          const slippagePercent = slippageBps / 100;

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
        slippageBps,
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
      token0Price = await this.getTokenPrice(poolConfig.token0Name);
    }
    if (poolConfig.token1 !== this.USDC_ADDRESS) {
      token1Price = await this.getTokenPrice(poolConfig.token1Name);
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

    console.log('Total USD comparison:', {
      totalStoredUSD: totalStoredUSD.toFixed(2),
      totalCalculatedUSD: totalCalculatedUSD.toFixed(2),
      difference: Math.abs(totalStoredUSD - totalCalculatedUSD).toFixed(2),
    });

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
        const { txResult } = await this.swapTokens(
          createAerodromeLpDto.walletLocator,
          poolConfig.token0,
          poolConfig.token1,
          sellAmountToken0.toString(),
          100, // 1% slippage
        );

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
        const { txResult } = await this.swapTokens(
          createAerodromeLpDto.walletLocator,
          poolConfig.token1,
          poolConfig.token0,
          sellAmountToken1.toString(),
          100, // 1% slippage
        );

        swapResults.token1Swap = {
          transactionHash: txResult.transactionHash,
          status: txResult.status,
        };
      }
    } else {
      console.log('No rebalancing needed, amounts are close enough');
    }

    // For now, use the calculated amounts (a and b) as the target amounts
    const amount0Used = a;
    const amount1Used = b;

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

      // Get price feed ID from Pyth
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

      console.log(`Price for ${tokenName}: $${price}`);
      return price;
    } catch (error) {
      console.error(`Error getting price for ${tokenName}:`, error);
      throw new Error(`Failed to get price for ${tokenName}: ${error.message}`);
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

    if (poolConfig.token0 === this.USDC_ADDRESS) {
      token0Price = 1.0; // USDC price is always $1.00
      console.log('Token0 is USDC, price: $1.00');
    } else {
      // Get token0 price from Pyth using token0Name from pool config
      token0Price = await this.getTokenPrice(poolConfig.token0Name);
    }

    if (poolConfig.token1 === this.USDC_ADDRESS) {
      token1Price = 1.0; // USDC price is always $1.00
      console.log('Token1 is USDC, price: $1.00');
    } else {
      // Get token1 price from Pyth using token1Name from pool config
      token1Price = await this.getTokenPrice(poolConfig.token1Name);
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
  ): Promise<TickRange> {
    console.log('=== Calculating Tick Range ===');
    console.log('Pool Address:', poolAddress);
    console.log('Tick Spacing:', tickSpacing);
    console.log('Percent Deviation:', percentDeviation);

    // Constants for tick math
    const LOG_BASE = Math.log(1.0001);

    try {
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

      const sqrtPriceX96 = decodedResult.sqrtPriceX96;
      const tickCurrent = decodedResult.tick;

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

      // 2. Calculate lower and upper price bounds for ±N%
      const percent = percentDeviation / 100;
      const lowerPrice = currentPrice * (1 - percent);
      const upperPrice = currentPrice * (1 + percent);

      console.log('Price bounds:', {
        lowerPrice,
        upperPrice,
        percentDeviation: `${percentDeviation}%`,
      });

      // 3. Convert price bounds to ticks
      const tickLowerRaw = Math.floor(Math.log(lowerPrice) / LOG_BASE);
      const tickUpperRaw = Math.floor(Math.log(upperPrice) / LOG_BASE);

      // 4. Round ticks to the nearest valid tick based on tick spacing
      const tickLower = Math.round(tickLowerRaw / tickSpacing) * tickSpacing;
      const tickUpper = Math.round(tickUpperRaw / tickSpacing) * tickSpacing;

      console.log('Raw calculated ticks:', {
        tickLowerRaw,
        tickUpperRaw,
      });

      console.log('Rounded ticks (with spacing):', {
        tickCurrent,
        tickLower,
        tickUpper,
        tickSpacing,
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

      // Get current liquidity on-chain
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

      if (!liquidity || liquidity === 0n) {
        // If liquidity is already 0, just burn the NFT
        const burnResult = await this.sendTransaction(
          walletLocator,
          this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
          NonFungiblePositionManagerAbi as unknown as any[],
          'burn',
          [tokenId],
        );
        await this.aerodromePositionModel.findOneAndUpdate(
          { 'metadata.mintDetails.tokenId': tokenId.toString() },
          {
            status: 'closed',
            metadata: {
              ...position.metadata,
              burn: {
                decreaseLiquidityTx: null,
                burnTx: burnResult?.transactionHash,
                timestamp: new Date().toISOString(),
              },
            },
          },
        );

        return {
          message: 'Position had zero liquidity and was burned successfully',
          tokenId,
          decreaseLiquidityTx: null,
          burnTx: burnResult?.transactionHash,
        };
      }

      // 2. Remove all liquidity
      const decreaseParams = {
        tokenId: BigInt(tokenId),
        liquidity: BigInt(liquidity),
        amount0Min: 0,
        amount1Min: 0,
        deadline: Math.floor(Date.now() / 1000) + 1800,
      };
      const decreaseResult = await this.sendTransaction(
        walletLocator,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'decreaseLiquidity',
        [decreaseParams],
      );

      // 3. Get token0 and token1 balances before collecting fees
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

      // 4. Collect fees
      const collectFeesResult = await this.collectFees(
        walletLocator,
        tokenId,
        true,
      );

      // 5. Get token0 and token1 balances after collect
      const token0BalanceAfterRaw = await this.readContract(
        poolConfig.token0,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token1BalanceAfterRaw = await this.readContract(
        poolConfig.token1,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );
      const token0BalanceAfter = BigInt(token0BalanceAfterRaw);
      const token1BalanceAfter = BigInt(token1BalanceAfterRaw);

      // 6. Burn the NFT
      const burnResult = await this.sendTransaction(
        walletLocator,
        this.NON_FUNGIBLE_POSITION_MANAGER_ADDRESS,
        NonFungiblePositionManagerAbi as unknown as any[],
        'burn',
        [tokenId],
      );

      // 7. Calculate total received
      const receivedToken0 =
        prevCollected0 + (token0BalanceAfter - token0BalanceBefore);
      const receivedToken1 =
        prevCollected1 + (token1BalanceAfter - token1BalanceBefore);

      // Add unused amounts from previous mint (if any)
      const prevMintDetails = position.metadata?.mintDetails;
      const amount0Unused = prevMintDetails?.amount0Unused
        ? BigInt(prevMintDetails.amount0Unused)
        : 0n;
      const amount1Unused = prevMintDetails?.amount1Unused
        ? BigInt(prevMintDetails.amount1Unused)
        : 0n;

      const totalAvailableToken0 = receivedToken0 + amount0Unused;
      const totalAvailableToken1 = receivedToken1 + amount1Unused;
      console.log(
        'Total available after burn (including unused from previous mint):',
        {
          totalAvailableToken0: totalAvailableToken0.toString(),
          totalAvailableToken1: totalAvailableToken1.toString(),
          receivedToken0: receivedToken0.toString(),
          receivedToken1: receivedToken1.toString(),
          amount0Unused: amount0Unused.toString(),
          amount1Unused: amount1Unused.toString(),
        },
      );

      // === Handle token amounts based on whether this is a rebalance or normal burn ===
      const actualReceivedToken0 = token0BalanceAfter - token0BalanceBefore;
      const actualReceivedToken1 = token1BalanceAfter - token1BalanceBefore;

      let withdrawAmountFinal = 0;
      let tokenAmountsForRebalance = null;

      if (isRebalance) {
        // For rebalance: Store token amounts instead of swapping to USDC
        console.log(
          '=== REBALANCE MODE: Storing token amounts instead of swapping ===',
        );

        // Calculate the amounts to use for rebalancing based on your logic:
        // 1. If balance > totalAvailable, use totalAvailable
        // 2. If balance <= totalAvailable, use actualReceived
        // 3. If actualReceived > balance, use balance difference
        const rebalanceToken0Amount =
          token0BalanceAfter > totalAvailableToken0
            ? totalAvailableToken0
            : actualReceivedToken0 > token0BalanceAfter
              ? token0BalanceAfter - token0BalanceBefore
              : actualReceivedToken0;

        const rebalanceToken1Amount =
          token1BalanceAfter > totalAvailableToken1
            ? totalAvailableToken1
            : actualReceivedToken1 > token1BalanceAfter
              ? token1BalanceAfter - token1BalanceBefore
              : actualReceivedToken1;

        console.log('Rebalance token amounts:', {
          rebalanceToken0Amount: rebalanceToken0Amount.toString(),
          rebalanceToken1Amount: rebalanceToken1Amount.toString(),
          token0BalanceAfter: token0BalanceAfter.toString(),
          token1BalanceAfter: token1BalanceAfter.toString(),
          totalAvailableToken0: totalAvailableToken0.toString(),
          totalAvailableToken1: totalAvailableToken1.toString(),
          actualReceivedToken0: actualReceivedToken0.toString(),
          actualReceivedToken1: actualReceivedToken1.toString(),
        });

        // Calculate USD values for the stored amounts (similar to cleanupFailedMint)
        let token0USDValue = 0;
        let token1USDValue = 0;

        if (poolConfig.token0 === this.USDC_ADDRESS) {
          token0USDValue =
            Number(rebalanceToken0Amount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token0Price = await this.getTokenPrice(poolConfig.token0Name);
            token0USDValue =
              (Number(rebalanceToken0Amount) /
                Math.pow(10, poolConfig.token0Decimals)) *
              token0Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token0Name}:`,
              error,
            );
            token0USDValue = 0;
          }
        }

        if (poolConfig.token1 === this.USDC_ADDRESS) {
          token1USDValue =
            Number(rebalanceToken1Amount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          try {
            const token1Price = await this.getTokenPrice(poolConfig.token1Name);
            token1USDValue =
              (Number(rebalanceToken1Amount) /
                Math.pow(10, poolConfig.token1Decimals)) *
              token1Price;
          } catch (error) {
            console.error(
              `Failed to get price for ${poolConfig.token1Name}:`,
              error,
            );
            token1USDValue = 0;
          }
        }

        const totalUSDValue = token0USDValue + token1USDValue;
        withdrawAmountFinal = totalUSDValue;

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

        // Negation logic: if token0BalanceAfter <= receivedToken0, use actualReceivedToken0, else use receivedToken0
        const swapAmountToken0 =
          token0BalanceAfter <= totalAvailableToken0
            ? actualReceivedToken0
            : totalAvailableToken0;
        const swapAmountToken1 =
          token1BalanceAfter <= totalAvailableToken1
            ? actualReceivedToken1
            : totalAvailableToken1;
        let usdcFromToken0 = 0;
        let usdcFromToken1 = 0;
        const slippageBps = 100;
        if (poolConfig.token0 !== this.USDC_ADDRESS && swapAmountToken0 > 0n) {
          const { buyAmount } = await this.swapTokens(
            walletLocator,
            poolConfig.token0,
            this.USDC_ADDRESS,
            swapAmountToken0.toString(),
            slippageBps,
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
            slippageBps,
          );
          usdcFromToken1 = Number(buyAmount) / Math.pow(10, this.USDC_DECIMALS);
        } else {
          usdcFromToken1 =
            Number(swapAmountToken1) / Math.pow(10, poolConfig.token1Decimals);
        }
        console.log('USDC from token0:', usdcFromToken0);
        console.log('USDC from token1:', usdcFromToken1);
        withdrawAmountFinal = usdcFromToken0 + usdcFromToken1;
      }

      // 8. Update DB: mark position as closed/burned and store withdrawAmountFinal
      await this.aerodromePositionModel.findOneAndUpdate(
        { 'metadata.mintDetails.tokenId': tokenId.toString() },
        {
          status: 'closed',
          metadata: {
            ...position.metadata,
            burn: {
              decreaseLiquidityTx: decreaseResult?.transactionHash,
              burnTx: burnResult?.transactionHash,
              collectFeesTx: collectFeesResult?.transactionHash,
              timestamp: new Date().toISOString(),
            },
            withdrawAmountFinal,
          },
        },
      );

      // 9. Return result
      const result: any = {
        message: 'Position fully closed and burned successfully',
        tokenId,
        decreaseLiquidityTx: decreaseResult?.transactionHash,
        burnTx: burnResult?.transactionHash,
        collectFeesTx: collectFeesResult?.transactionHash,
        totalTokensReceived: {
          token0: receivedToken0.toString(),
          token1: receivedToken1.toString(),
        },
        withdrawAmountFinal,
        balances: {
          before: {
            token0: token0BalanceBefore.toString(),
            token1: token1BalanceBefore.toString(),
          },
          after: {
            token0: token0BalanceAfter.toString(),
            token1: token1BalanceAfter.toString(),
          },
        },
        prevCollectedFees: {
          token0: prevCollected0.toString(),
          token1: prevCollected1.toString(),
        },
        collectFeesResult,
      };

      // Add token amounts for rebalance if this was a rebalance operation
      if (isRebalance && tokenAmountsForRebalance) {
        result.tokenAmountsForRebalance = tokenAmountsForRebalance;
      }

      return result;
    } catch (error) {
      console.error('Error burning position:', error);
      throw new HttpException(
        error.message || 'Failed to burn position',
        error.status || 500,
      );
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

      // === APR CALCULATION ===
      let apr = 0;
      let totalFeesUSD = 0;

      // Only calculate APR if not skipping
      if (!skipAprCalculation) {
        if (
          position &&
          position.pool &&
          position.usdcAmount &&
          (position as any).createdAt
        ) {
          try {
            console.log('=== Calculating APR ===');
            // Get pool configuration to determine token names and decimals
            const poolConfig = getPoolConfig(position.pool);
            if (!poolConfig) {
              console.warn(
                `Pool config not found for pool ${position.pool}, skipping APR calculation`,
              );
            } else {
              // Get current token prices
              const token0Price = await this.getTokenPrice(
                poolConfig.token0Name,
              );
              const token1Price = await this.getTokenPrice(
                poolConfig.token1Name,
              );

              console.log('Token prices for APR calculation:', {
                token0Name: poolConfig.token0Name,
                token1Name: poolConfig.token1Name,
                token0Price,
                token1Price,
              });

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
    reason: 'out_of_range' | 'dollar_fees' | 'imbalanced' | 'age_limit',
  ) {
    try {
      console.log(
        `=== Adding Position ${positionId} to Rebalancing Queue (Reason: ${reason}) ===`,
      );

      // Get the position details
      const position = await this.aerodromePositionModel.findOne({
        positionId,
      });
      if (!position) {
        throw new HttpException(`Position ${positionId} not found`, 404);
      }

      if (position.status !== 'active') {
        throw new HttpException(
          `Position ${positionId} is not active (status: ${position.status})`,
          400,
        );
      }

      // Check if wallet is already rebalancing
      const isRebalancing = await this.isWalletRebalancing(
        position.walletLocator,
      );
      if (isRebalancing) {
        console.log(
          `Wallet ${position.walletLocator} is already rebalancing, adding to queue`,
        );
      }

      // Add to wallet queue
      await this.addToWalletQueue(position.walletLocator, positionId, reason);

      return {
        success: true,
        message: `Position ${positionId} added to rebalancing queue`,
        walletLocator: position.walletLocator,
        reason,
        queued: isRebalancing,
      };
    } catch (error) {
      console.error(
        `Error adding position ${positionId} to rebalancing queue:`,
        error,
      );
      throw new HttpException(
        `Failed to add position to rebalancing queue: ${error.message}`,
        error.status || 500,
      );
    }
  }

  /**
   * Internal method that performs the actual rebalancing
   */
  private async rebalancePositionInternal(
    positionId: string,
    reason: 'out_of_range' | 'dollar_fees' | 'imbalanced' | 'age_limit',
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

      // Step 1: Burn the old position (this will also collect fees)
      console.log('Step 1: Burning old position...');
      const tokenId = position.metadata?.mintDetails?.tokenId;
      const burnResult = await this.burn(position.walletLocator, tokenId, true); // Pass isRebalance=true
      console.log('Burn result:', burnResult);

      // Step 2: Use the token amounts from burn result for rebalancing
      const originalUsdcAmount = position.usdcAmount;
      const totalTokensReceived = burnResult.totalTokensReceived;

      // For rebalance, use the stored token amounts instead of USDC amount
      const newUsdcAmount =
        burnResult.tokenAmountsForRebalance?.totalUSDValue ||
        burnResult.withdrawAmountFinal;

      console.log('Rebalance calculation:', {
        original: originalUsdcAmount,
        totalTokensReceived,
        newTotal: newUsdcAmount,
        tokenAmountsForRebalance: burnResult.tokenAmountsForRebalance,
      });

      // Step 3: Mint new position with updated amount
      console.log('Step 3: Minting new position...');

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

      const newPositionDto = {
        walletLocator: position.walletLocator,
        pool: position.pool,
        usdcAmount: newUsdcAmount,
        description: `Rebalanced position (${reason}) - Original: ${originalUsdcAmount} USDC, New total: ${newUsdcAmount} USDC`,
        rebalancedPositionId: positionId, // Pass the original position ID being rebalanced
        percentDeviation: originalPercentDeviation, // Pass the original percentDeviation
        isRebalanceOrRetry: true, // Add flag for rebalancing flow
        positionId: positionId, // Pass the position ID to get stored token amounts
      };

      console.log('Rebalance newPositionDto with percentDeviation:', {
        percentDeviation: newPositionDto.percentDeviation,
        type: typeof newPositionDto.percentDeviation,
      });

      // Create a proper DTO instance to ensure validation works correctly
      const mintDto = new CreateAerodromeLpDto();
      Object.assign(mintDto, newPositionDto);

      console.log('Rebalance created DTO instance:', {
        dtoKeys: Object.keys(mintDto),
        hasPercentDeviation: 'percentDeviation' in mintDto,
        percentDeviation: mintDto.percentDeviation,
      });

      const mintResult = await this.mint(mintDto);
      console.log('Mint result:', mintResult);

      // Step 4: Update the original position record with rebalancing info and clear rebalancing flag
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
    slippageBps: number = 100,
  ): Promise<{ buyAmount: string; txResult: any }> {
    const walletAddress = this.getWalletAddressFromLocator(walletLocator);
    const slippagePercent = slippageBps / 100; // Convert bps to percentage

    console.log('=== Starting swap with 0x fallback to 1inch ===');
    console.log('Parameters:', {
      walletLocator,
      sellToken,
      buyToken,
      sellAmountRaw,
      slippageBps,
      slippagePercent,
    });

    // Try 0x first
    try {
      console.log('Attempting swap with 0x...');
      return await this.swapWith0x(
        walletLocator,
        sellToken,
        buyToken,
        sellAmountRaw,
        slippageBps,
        walletAddress,
      );
    } catch (error) {
      console.error('0x swap failed, falling back to 1inch:', error);

      // Fall back to 1inch
      try {
        console.log('Attempting swap with 1inch...');
        return await this.swapWith1inch(
          walletLocator,
          sellToken,
          buyToken,
          sellAmountRaw,
          slippagePercent,
          walletAddress,
        );
      } catch (oneInchError) {
        console.error('Both 0x and 1inch swaps failed:', {
          oxError: error.message,
          oneInchError: oneInchError.message,
        });
        throw new Error(
          `Swap failed on both 0x and 1inch. 0x error: ${error.message}. 1inch error: ${oneInchError.message}`,
        );
      }
    }
  }

  /**
   * Swap using 0x API
   */
  private async swapWith0x(
    walletLocator: string,
    sellToken: string,
    buyToken: string,
    sellAmountRaw: string,
    slippageBps: number,
    walletAddress: string,
  ): Promise<{ buyAmount: string; txResult: any }> {
    console.log('=== Executing 0x Swap ===');

    //current balance of sellToken
    const currentBalance = await this.readContract(
      sellToken,
      ERC20_ABI as unknown as any[],
      'balanceOf',
      [walletAddress],
    );

    // Decode the balance
    const { decodeFunctionResult } = await import('viem');
    const decodedBalance = decodeFunctionResult({
      abi: ERC20_ABI as any,
      functionName: 'balanceOf',
      data: currentBalance,
    });

    console.log('currentBalance raw:', currentBalance);
    console.log('currentBalance decoded:', decodedBalance.toString());

    // Get price quote
    const priceQuote = await this.get0xPrice(
      sellToken,
      buyToken,
      sellAmountRaw,
      walletAddress,
      slippageBps,
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
      slippageBps,
    );

    // Execute swap
    const txResult = await this.sendRawTransaction(
      walletLocator,
      swapQuote.transaction.to,
      swapQuote.transaction.data,
      swapQuote.transaction.value || '0',
    );

    return { buyAmount: swapQuote.buyAmount, txResult };
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
  ): Promise<{ buyAmount: string; txResult: any }> {
    console.log('=== Executing 1inch Swap ===');

    try {
      // Get spender address for approval
      const spenderAddress = await this.get1inchSpender();
      console.log('spenderAddress', spenderAddress);

      //current balance of sellToken
      const currentBalance = await this.readContract(
        sellToken,
        ERC20_ABI as unknown as any[],
        'balanceOf',
        [walletAddress],
      );

      // Decode the balance
      const { decodeFunctionResult } = await import('viem');
      const decodedBalance = decodeFunctionResult({
        abi: ERC20_ABI as any,
        functionName: 'balanceOf',
        data: currentBalance,
      });

      console.log('currentBalance raw:', currentBalance);
      console.log('currentBalance decoded:', decodedBalance.toString());

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

      return { buyAmount: swapResponse.dstAmount || sellAmountRaw, txResult };
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
  ): Promise<{ buyAmount: string; txResult: any }> {
    console.log('=== Executing Alternative 1inch Swap ===');

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

    // For the alternative method, we don't have the exact buy amount
    // We'll use the sell amount as a fallback
    return { buyAmount: sellAmountRaw, txResult };
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
    dollarFees: any[];
    imbalanced: any[];
    ageLimit: any[];
  }> {
    try {
      console.log('=== Getting Positions Needing Rebalancing ===');

      // Get active positions for current pool
      const activePositions = await this.getAllActivePositions();

      if (activePositions.length === 0) {
        console.log('No active positions found for current pool');
        return {
          outOfRange: [],
          dollarFees: [],
          imbalanced: [],
          ageLimit: [],
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
        (position) => !rebalancingWallets.includes(position.walletLocator),
      );

      console.log(
        `Available positions (excluding rebalancing wallets): ${availablePositions.length}`,
      );

      const results = {
        outOfRange: [] as any[],
        dollarFees: [] as any[],
        imbalanced: [] as any[],
        ageLimit: [] as any[],
      };

      console.log('availablePositions', availablePositions);

      // Check for out-of-range positions (highest priority)
      const outOfRangePositions =
        await this.getOutOfRangePositions(availablePositions);
      results.outOfRange = outOfRangePositions;

      // Check for dollar value loss positions
      const dollarValuePositions =
        await this.getDollarValuePositions(availablePositions);
      results.dollarFees = dollarValuePositions;

      // Check for imbalanced token positions
      const imbalancedPositions =
        await this.getImbalancedPositions(availablePositions);
      results.imbalanced = imbalancedPositions;

      // Check for age-limit positions (24 hours threshold)
      const ageLimitPositions =
        await this.getAgeLimitPositions(availablePositions);
      results.ageLimit = ageLimitPositions;

      console.log('Rebalancing analysis results:', {
        outOfRange: results.outOfRange.length,
        dollarFees: results.dollarFees.length,
        imbalanced: results.imbalanced.length,
        ageLimit: results.ageLimit.length,
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

          const isOutOfRange =
            currentTick < tickRange.tickLower ||
            currentTick > tickRange.tickUpper;

          console.log(`Position ${position.positionId} tick check:`, {
            currentTick,
            tickLower: tickRange.tickLower,
            tickUpper: tickRange.tickUpper,
            isOutOfRange,
            belowLower: currentTick < tickRange.tickLower,
            aboveUpper: currentTick > tickRange.tickUpper,
          });

          if (isOutOfRange) {
            console.log(
              `Position ${position.positionId} is out of range: current tick ${currentTick} outside range [${tickRange.tickLower}, ${tickRange.tickUpper}]`,
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
   * Check which positions have lost more than 2% of their original USDC value
   * This triggers rebalancing when current token values are below 98% of original investment
   */
  private async getDollarValuePositions(
    activePositions: any[],
  ): Promise<any[]> {
    try {
      console.log('=== Checking for Dollar Value Loss Positions ===');

      if (activePositions.length === 0) {
        console.log('No active positions to check for dollar value loss');
        return [];
      }

      // Get all pools to analyze
      const allPools = this.getAllPoolsToAnalyze();
      const dollarValuePositions: any[] = [];

      // Check each pool for dollar value loss positions
      for (const pool of allPools) {
        const poolConfig = getPoolConfig(pool);

        if (!poolConfig) {
          console.warn(`Pool config not found for pool ${pool}`);
          continue;
        }

        // Filter positions for this specific pool
        const poolPositions = activePositions.filter(
          (pos) => pos.pool === pool,
        );

        // Check each position for dollar value loss
        for (const position of poolPositions) {
          try {
            console.log(
              `Checking dollar value for position ${position.positionId} in pool ${pool}`,
            );

            // Get current token amounts
            const { amount0, amount1 } =
              await this.getCurrentTokenAmounts(position);

            // Get token prices
            const token0Price = await this.getTokenPrice(poolConfig.token0Name);
            const token1Price = await this.getTokenPrice(poolConfig.token1Name);

            // Convert amounts to human-readable values
            const amount0Human =
              Number(amount0) / Math.pow(10, poolConfig.token0Decimals);
            const amount1Human =
              Number(amount1) / Math.pow(10, poolConfig.token1Decimals);

            // Calculate current dollar values
            const token0DollarValue = amount0Human * token0Price;
            const token1DollarValue = amount1Human * token1Price;
            const totalDollarValue = token0DollarValue + token1DollarValue;

            // Get original USDC amount
            const originalUsdcAmount = position.usdcAmount;

            // Calculate loss percentage
            const lossPercentage =
              ((originalUsdcAmount - totalDollarValue) / originalUsdcAmount) *
              100;

            console.log('Dollar value analysis:', {
              positionId: position.positionId,
              originalUsdcAmount,
              totalDollarValue,
              lossPercentage: lossPercentage.toFixed(2) + '%',
            });

            // Check if loss is significant (>2%)
            if (lossPercentage > 2) {
              console.log(
                `Position ${position.positionId} has significant dollar value loss: ${lossPercentage.toFixed(2)}%`,
              );
              dollarValuePositions.push(position);
            }
          } catch (error) {
            console.error(
              `Error checking dollar value for position ${position.positionId}:`,
              error,
            );
          }
        }
      }

      console.log(
        `Found ${dollarValuePositions.length} positions with significant dollar value loss across all pools`,
      );
      return dollarValuePositions;
    } catch (error) {
      console.error('Error checking for dollar value loss positions:', error);
      return []; // Return empty array on error to avoid breaking the entire process
    }
  }

  /**
   * Check which positions have imbalanced token ratios (one token >85% or <15% of total value)
   * This triggers rebalancing when token distribution deviates significantly from 50/50
   * SKIPS narrow range positions (percentDeviation < 2%) to avoid excessive rebalancing
   */
  private async getImbalancedPositions(activePositions: any[]): Promise<any[]> {
    try {
      console.log('=== Checking for Imbalanced Token Positions ===');

      if (activePositions.length === 0) {
        console.log('No active positions to check for token imbalance');
        return [];
      }

      // Get current pool being analyzed
      const currentPool = this.getAllPoolsToAnalyze()[0];
      const poolConfig = getPoolConfig(currentPool);

      if (!poolConfig) {
        console.warn(`Pool config not found for pool ${currentPool}`);
        return [];
      }

      const imbalancedPositions: any[] = [];

      // Check each position for token imbalance
      for (const position of activePositions) {
        try {
          console.log(
            `Checking token balance for position ${position.positionId}`,
          );

          // Skip narrow range positions to avoid excessive rebalancing
          const tickRange = position.metadata?.tickRange;
          const percentDeviation = tickRange?.percentDeviation;

          if (percentDeviation !== undefined && percentDeviation < 2) {
            console.log(
              `Position ${position.positionId} has narrow range (${percentDeviation}% deviation), skipping imbalance check`,
            );
            continue;
          }

          // Get current token amounts
          const { amount0, amount1 } =
            await this.getCurrentTokenAmounts(position);

          // Get token prices
          const token0Price = await this.getTokenPrice(poolConfig.token0Name);
          const token1Price = await this.getTokenPrice(poolConfig.token1Name);

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
          const totalDollarValue = token0DollarValue + token1DollarValue;

          // Calculate token ratios
          const token0Ratio =
            totalDollarValue > 0 ? token0DollarValue / totalDollarValue : 0;
          const token1Ratio =
            totalDollarValue > 0 ? token1DollarValue / totalDollarValue : 0;

          // Define imbalance thresholds (85/15 ratio - less aggressive than 80/20)
          const IMBALANCE_THRESHOLD = 0.85; // 85%
          const MIN_RATIO = 0.15; // 15%

          console.log('Token ratio analysis:', {
            token0DollarValue,
            token1DollarValue,
            totalDollarValue,
            token0Ratio: (token0Ratio * 100).toFixed(2) + '%',
            token1Ratio: (token1Ratio * 100).toFixed(2) + '%',
            threshold: (IMBALANCE_THRESHOLD * 100).toFixed(2) + '% (85%)',
            minRatio: (MIN_RATIO * 100).toFixed(2) + '% (15%)',
            percentDeviation,
          });

          // Check if either token exceeds 80% or falls below 20%
          const isToken0Imbalanced =
            token0Ratio > IMBALANCE_THRESHOLD || token0Ratio < MIN_RATIO;
          const isToken1Imbalanced =
            token1Ratio > IMBALANCE_THRESHOLD || token1Ratio < MIN_RATIO;
          const isImbalanced = isToken0Imbalanced || isToken1Imbalanced;

          if (isImbalanced) {
            console.log(
              `Position ${position.positionId} has IMBALANCED TOKENS (85/15 threshold):`,
              {
                token0Ratio: (token0Ratio * 100).toFixed(2) + '%',
                token1Ratio: (token1Ratio * 100).toFixed(2) + '%',
                token0Imbalanced: isToken0Imbalanced,
                token1Imbalanced: isToken1Imbalanced,
                percentDeviation,
                reason: isToken0Imbalanced
                  ? `Token0 (${poolConfig.token0Name}) is ${token0Ratio > IMBALANCE_THRESHOLD ? 'overweight (>85%)' : 'underweight (<15%)'}`
                  : `Token1 (${poolConfig.token1Name}) is ${token1Ratio > IMBALANCE_THRESHOLD ? 'overweight (>85%)' : 'underweight (<15%)'}`,
              },
            );

            // Add position to rebalancing list
            position.imbalanceAnalysis = {
              token0DollarValue,
              token1DollarValue,
              totalDollarValue,
              token0Ratio,
              token1Ratio,
              isToken0Imbalanced,
              isToken1Imbalanced,
              overweightToken:
                token0Ratio > token1Ratio
                  ? poolConfig.token0Name
                  : poolConfig.token1Name,
              overweightRatio: Math.max(token0Ratio, token1Ratio),
              underweightRatio: Math.min(token0Ratio, token1Ratio),
              percentDeviation,
            };
            imbalancedPositions.push(position);
          } else {
            console.log(
              `Position ${position.positionId} token balance OK: ${(token0Ratio * 100).toFixed(2)}% / ${(token1Ratio * 100).toFixed(2)}%`,
            );
          }
        } catch (error) {
          console.error(
            `Error checking token balance for position ${position.positionId}:`,
            error,
          );
          // Continue with other positions instead of failing completely
        }
      }

      console.log(
        `Found ${imbalancedPositions.length} imbalanced token positions out of ${activePositions.length} total`,
      );
      return imbalancedPositions;
    } catch (error) {
      console.error('Error checking for imbalanced token positions:', error);
      return []; // Return empty array on error to avoid breaking the entire process
    }
  }

  /**
   * Check which positions are older than 2 days (48 hours)
   * This triggers rebalancing for aged positions
   */
  private async getAgeLimitPositions(activePositions: any[]): Promise<any[]> {
    try {
      console.log('=== Checking for Age-Limit Positions ===');
      if (activePositions.length === 0) {
        console.log('No active positions to check for age limit');
        return [];
      }

      const now = Date.now();

      // Use a fixed age threshold of 24 hours for age-limit rebalancing
      // This is separate from timeSinceLastRun which is used for cron scheduling
      const ageThreshold = 24 * 60 * 60 * 1000; // 24 hours
      const thresholdTime = now - ageThreshold;

      console.log(
        `Dynamic age threshold: ${(ageThreshold / 1000 / 60 / 60).toFixed(2)} hours`,
      );
      console.log(
        `Checking for positions older than: ${new Date(thresholdTime).toISOString()}`,
      );

      const agedPositions = activePositions.filter((position) => {
        const createdAt = position.createdAt
          ? new Date(position.createdAt).getTime()
          : null;
        if (!createdAt) return false;
        return createdAt < thresholdTime;
      });

      const thresholdHours = (ageThreshold / 1000 / 60 / 60).toFixed(2);
      console.log(
        `Found ${agedPositions.length} positions older than ${thresholdHours} hours out of ${activePositions.length} total`,
      );
      return agedPositions;
    } catch (error) {
      console.error('Error checking for age-limit positions:', error);
      return [];
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

      if (position.status !== 'mint_failed') {
        console.log(
          `Position ${positionId} is not in mint_failed status, skipping cleanup`,
        );
        return;
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
          const token0Price = await this.getTokenPrice(poolConfig.token0Name);
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
          const token1Price = await this.getTokenPrice(poolConfig.token1Name);
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
      outOfRange: {
        found: number;
        processed: number;
        successful: number;
        failed: number;
        skipped: number;
      };
      dollarFees: {
        found: number;
        processed: number;
        successful: number;
        failed: number;
        skipped: number;
      };
      imbalanced: {
        found: number;
        processed: number;
        successful: number;
        failed: number;
        skipped: number;
      };
      ageLimit: {
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

      // Get positions that need rebalancing with dynamic time criteria
      const positionsNeedingRebalancing =
        await this.getPositionsNeedingRebalancing();

      const results = {
        pools: allPools.join(', '),
        totalPositions: 0,
        outOfRange: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
        dollarFees: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
        imbalanced: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
        ageLimit: {
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

      // Process dollar value loss positions
      results.dollarFees.found = positionsNeedingRebalancing.dollarFees.length;
      console.log(
        `Found ${results.dollarFees.found} dollar value loss positions`,
      );

      for (const position of positionsNeedingRebalancing.dollarFees) {
        try {
          console.log(
            `Processing dollar value loss position: ${position.positionId}`,
          );
          results.dollarFees.processed++;

          const rebalanceResult = await this.rebalancePosition(
            position.positionId,
            'dollar_fees',
          );

          if (rebalanceResult.success) {
            results.dollarFees.successful++;
            console.log(
              `✅ Successfully added position ${position.positionId} to rebalancing queue`,
            );
          } else {
            results.dollarFees.failed++;
            console.log(
              `❌ Failed to add position ${position.positionId} to queue: ${rebalanceResult.message}`,
            );
          }
        } catch (error) {
          results.dollarFees.failed++;
          console.error(
            `❌ Error processing dollar value loss position ${position.positionId}:`,
            error,
          );
        }
      }

      // Process imbalanced token positions
      results.imbalanced.found = positionsNeedingRebalancing.imbalanced.length;
      console.log(
        `Found ${results.imbalanced.found} imbalanced token positions`,
      );

      for (const position of positionsNeedingRebalancing.imbalanced) {
        try {
          console.log(
            `Processing imbalanced token position: ${position.positionId}`,
          );
          results.imbalanced.processed++;

          const rebalanceResult = await this.rebalancePosition(
            position.positionId,
            'imbalanced',
          );

          if (rebalanceResult.success) {
            results.imbalanced.successful++;
            console.log(
              `✅ Successfully added position ${position.positionId} to rebalancing queue`,
            );
          } else {
            results.imbalanced.failed++;
            console.log(
              `❌ Failed to add position ${position.positionId} to queue: ${rebalanceResult.message}`,
            );
          }
        } catch (error) {
          results.imbalanced.failed++;
          console.error(
            `❌ Error processing imbalanced token position ${position.positionId}:`,
            error,
          );
        }
      }

      // Process age-limit positions
      results.ageLimit.found = positionsNeedingRebalancing.ageLimit.length;
      console.log(`Found ${results.ageLimit.found} age-limit positions`);
      for (const position of positionsNeedingRebalancing.ageLimit) {
        try {
          console.log(`Processing age-limit position: ${position.positionId}`);
          results.ageLimit.processed++;

          const rebalanceResult = await this.rebalancePosition(
            position.positionId,
            'age_limit',
          );

          if (rebalanceResult.success) {
            results.ageLimit.successful++;
            console.log(
              `✅ Successfully added position ${position.positionId} to rebalancing queue`,
            );
          } else {
            results.ageLimit.failed++;
            console.log(
              `❌ Failed to add position ${position.positionId} to queue: ${rebalanceResult.message}`,
            );
          }
        } catch (error) {
          results.ageLimit.failed++;
          console.error(
            `❌ Error processing age-limit position ${position.positionId}:`,
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
          outOfRange: {
            found: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
          },
          dollarFees: {
            found: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
          },
          imbalanced: {
            found: 0,
            processed: 0,
            successful: 0,
            failed: 0,
            skipped: 0,
          },
          ageLimit: {
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

      // Get current token prices
      const token0Price = await this.getTokenPrice(poolConfig.token0Name);
      const token1Price = await this.getTokenPrice(poolConfig.token1Name);

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

      // Get original values for comparison
      let originalUsdcAmount = position.usdcAmount;
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
      };

      // Update the position with the new details
      await this.aerodromePositionModel.findOneAndUpdate(
        { positionId },
        {
          $push: {
            'metadata.positionHistory': detailsToSave,
          },
        },
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
    reason: string,
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
    reason: string,
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
      await this.performRebalance(
        nextPositionId,
        position.walletRebalancingQueue.currentReason,
      );
    } else {
      // No more positions in queue, clear the rebalancing state
      await this.clearWalletRebalancingState(walletLocator);
    }
  }

  /**
   * Clear a wallet's rebalancing state
   */
  async clearWalletRebalancingState(walletLocator: string) {
    console.log(`Clearing rebalancing state for wallet ${walletLocator}`);

    await this.aerodromePositionModel.updateMany(
      { walletLocator, 'walletRebalancingQueue.isRebalancing': true },
      {
        $unset: {
          walletRebalancingQueue: 1,
        },
      },
    );
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
  private async performRebalance(positionId: string, reason: string) {
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
        reason as 'out_of_range' | 'dollar_fees' | 'imbalanced' | 'age_limit',
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
}
