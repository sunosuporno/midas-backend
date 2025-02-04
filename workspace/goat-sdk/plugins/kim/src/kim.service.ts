import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { parseUnits } from 'viem';
import { encodeAbiParameters } from 'viem';
import { ERC20_ABI } from './abi/erc20';
import { KIM_FACTORY_ABI } from './abi/factory';
import { POOL_ABI } from './abi/pool';
import { CALCULATOR_ABI } from './abi/calculator';
import { POSITION_MANAGER_ABI } from './abi/positionManager';
import { SWAP_ROUTER_ABI } from './abi/swaprouter';
import {
  BurnParams,
  CollectParams,
  DecreaseLiquidityParams,
  ExactInputParams,
  ExactInputSingleParams,
  ExactOutputParams,
  ExactOutputSingleParams,
  GetSwapRouterAddressParams,
  IncreaseLiquidityParams,
  MintParams,
  GetLPTokensParams,
  CalculatePositionAPYParams,
} from './parameters';

const SWAP_ROUTER_ADDRESS = '0xAc48FcF1049668B285f3dC72483DF5Ae2162f7e8';
const POSITION_MANAGER_ADDRESS = '0x2e8614625226D26180aDf6530C3b1677d3D7cf10';
const FACTORY_ADDRESS = '0xB5F00c2C5f8821155D8ed27E31932CFD9DB3C5D5';
const CALCULATOR_ADDRESS = '0x6f8E2B58373aB12Be5f7c28658633dD27D689f0D';

export class KimService {
  @Tool({
    name: 'kim_get_swap_router_address',
    description: 'Get the address of the swap router',
  })
  async getSwapRouterAddress(parameters: GetSwapRouterAddressParams) {
    return SWAP_ROUTER_ADDRESS;
  }

  @Tool({
    description:
      "Swap an exact amount of input tokens for an output token in a single hop. Have the token amounts in their base units. Don't need to approve the swap router for the output token. User will have sufficient balance of the input token. The swap router address is already provided in the function. Returns a transaction hash on success. Once you get a transaction hash, the swap is complete - do not call this function again.",
  })
  async swapExactInputSingleHop(
    walletClient: EVMWalletClient,
    parameters: ExactInputSingleParams,
  ) {
    try {
      const approvalHash = await walletClient.sendTransaction({
        to: parameters.tokenInAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SWAP_ROUTER_ADDRESS, parameters.amountIn],
      });

      const timestamp = Math.floor(Date.now() / 1000) + parameters.deadline;

      const hash = await walletClient.sendTransaction({
        to: SWAP_ROUTER_ADDRESS,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: parameters.tokenInAddress,
            tokenOut: parameters.tokenOutAddress,
            recipient: walletClient.getAddress(),
            deadline: timestamp,
            amountIn: parameters.amountIn,
            amountOutMinimum: parameters.amountOutMinimum,
            limitSqrtPrice: parameters.limitSqrtPrice,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw Error(`Failed to swap exact input single hop: ${error}`);
    }
  }

  @Tool({
    name: 'kim_swap_exact_output_single_hop',
    description:
      "Swap an exact amount of output tokens for a single hop. Have the token amounts in their base units. Don't need to approve the swap router for the output token. User will have sufficient balance of the input token. The swap router address is already provided in the function. Returns a transaction hash on success. Once you get a transaction hash, the swap is complete - do not call this function again.",
  })
  async swapExactOutputSingleHop(
    walletClient: EVMWalletClient,
    parameters: ExactOutputSingleParams,
  ): Promise<string> {
    try {
      const tokenIn = parameters.tokenInAddress;
      const tokenOut = parameters.tokenOutAddress;

      const amountOut = parameters.amountOut;
      const amountInMaximum = parameters.amountInMaximum;
      const limitSqrtPrice = parameters.limitSqrtPrice;
      const timestamp = Math.floor(Date.now() / 1000) + parameters.deadline;

      const approvalHash = await walletClient.sendTransaction({
        to: parameters.tokenInAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SWAP_ROUTER_ADDRESS, amountInMaximum],
      });

      const hash = await walletClient.sendTransaction({
        to: SWAP_ROUTER_ADDRESS,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactOutputSingle',
        args: [
          {
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            recipient: walletClient.getAddress(),
            deadline: timestamp,
            amountOut: amountOut,
            amountInMaximum: amountInMaximum,
            limitSqrtPrice: limitSqrtPrice,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw Error(`Failed to swap exact output single hop: ${error}`);
    }
  }

  @Tool({
    name: 'kim_swap_exact_input_multi_hop',
    description: 'Swap an exact amount of input tokens in multiple hops',
  })
  async swapExactInputMultiHop(
    walletClient: EVMWalletClient,
    parameters: ExactInputParams,
  ): Promise<string> {
    try {
      const recipient = await walletClient.resolveAddress(parameters.recipient);

      // Get first and last token decimals
      const tokenInDecimals = Number(
        await walletClient.read({
          address: parameters.path.tokenIn as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      );

      const tokenOutDecimals = Number(
        await walletClient.read({
          address: parameters.path.tokenOut as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      );

      // Encode the path
      const encodedPath = encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'uint24[]' }],
        [
          [
            parameters.path.tokenIn as `0x${string}`,
            ...parameters.path.intermediateTokens.map(
              (t: string) => t as `0x${string}`,
            ),
            parameters.path.tokenOut as `0x${string}`,
          ],
          parameters.path.fees,
        ],
      );

      const hash = await walletClient.sendTransaction({
        to: SWAP_ROUTER_ADDRESS,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactInput',
        args: [
          encodedPath,
          recipient,
          parameters.deadline,
          parseUnits(parameters.amountIn, tokenInDecimals),
          parseUnits(parameters.amountOutMinimum, tokenOutDecimals),
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to swap: ${error}`);
    }
  }

  @Tool({
    name: 'kim_swap_exact_output_multi_hop',
    description:
      'Swap tokens to receive an exact amount of output tokens in multiple hops',
  })
  async swapExactOutputMultiHop(
    walletClient: EVMWalletClient,
    parameters: ExactOutputParams,
  ): Promise<string> {
    try {
      const recipient = await walletClient.resolveAddress(parameters.recipient);

      // Get first and last token decimals
      const tokenInDecimals = Number(
        await walletClient.read({
          address: parameters.path.tokenIn as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      );

      const tokenOutDecimals = Number(
        await walletClient.read({
          address: parameters.path.tokenOut as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
      );

      // Encode the path
      const encodedPath = encodeAbiParameters(
        [{ type: 'address[]' }, { type: 'uint24[]' }],
        [
          [
            parameters.path.tokenIn as `0x${string}`,
            ...parameters.path.intermediateTokens.map(
              (t: string) => t as `0x${string}`,
            ),
            parameters.path.tokenOut as `0x${string}`,
          ],
          parameters.path.fees,
        ],
      );

      const hash = await walletClient.sendTransaction({
        to: SWAP_ROUTER_ADDRESS,
        abi: SWAP_ROUTER_ABI,
        functionName: 'exactOutput',
        args: [
          encodedPath,
          recipient,
          parameters.deadline,
          parseUnits(parameters.amountOut, tokenOutDecimals),
          parseUnits(parameters.amountInMaximum, tokenInDecimals),
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to swap: ${error}`);
    }
  }

  @Tool({
    name: 'kim_mint_position',
    description:
      'Mint a new liquidity position in a pool. Returns a transaction hash on success. Once you get a transaction hash, the mint is complete - do not call this function again.',
  })
  async mintPosition(
    walletClient: EVMWalletClient,
    parameters: MintParams,
  ): Promise<string> {
    try {
      // Get pool address
      const poolAddressResult = await walletClient.read({
        address: FACTORY_ADDRESS as `0x${string}`,
        abi: KIM_FACTORY_ABI,
        functionName: 'poolByPair',
        args: [parameters.token0Address, parameters.token1Address],
      });
      const poolAddress = poolAddressResult.value as `0x${string}`;

      const token0Result = await walletClient.read({
        address: poolAddress as `0x${string}`,
        abi: POOL_ABI,
        functionName: 'token0',
      });
      const token1Result = await walletClient.read({
        address: poolAddress as `0x${string}`,
        abi: POOL_ABI,
        functionName: 'token1',
      });

      const poolToken0 = (token0Result as { value: string }).value;
      const poolToken1 = (token1Result as { value: string }).value;

      // Check if parameters match pool order
      const isOrderMatched =
        parameters.token0Address.toLowerCase() === poolToken0.toLowerCase();

      // Set tokens and amounts in correct order
      const [token0, token1] = isOrderMatched
        ? [parameters.token0Address, parameters.token1Address]
        : [parameters.token1Address, parameters.token0Address];
      const [amount0Raw, amount1Raw] = isOrderMatched
        ? [parameters.amount0Desired, parameters.amount1Desired]
        : [parameters.amount1Desired, parameters.amount0Desired];
      const calculatorResult = await walletClient.read({
        address: CALCULATOR_ADDRESS as `0x${string}`,
        abi: CALCULATOR_ABI,
        functionName: 'calculateOptimalAmounts',
        args: [poolAddress, amount0Raw, amount1Raw, parameters.riskLevel],
      });
      const {
        value: [optimalAmount0, optimalAmount1, tickLower, tickUpper],
      } = calculatorResult as {
        value: [bigint, bigint, number, number];
      };

      const approvalHash0 = await walletClient.sendTransaction({
        to: token0 as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POSITION_MANAGER_ADDRESS, optimalAmount0],
      });
      const approvalHash1 = await walletClient.sendTransaction({
        to: token1 as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POSITION_MANAGER_ADDRESS, optimalAmount1],
      });

      // Mint
      const timestamp = Math.floor(Date.now() / 1000) + parameters.deadline;

      const hash = await walletClient.sendTransaction({
        to: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: 'mint',
        args: [
          {
            token0,
            token1,
            tickLower,
            tickUpper,
            amount0Desired: optimalAmount0,
            amount1Desired: optimalAmount1,
            amount0Min: 0,
            amount1Min: 0,
            recipient: walletClient.getAddress(),
            deadline: timestamp,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to mint position: ${error}`);
    }
  }

  @Tool({
    name: 'kim_increase_liquidity',
    description:
      'Increase liquidity in an existing position. Returns a transaction hash on success. Once you get a transaction hash, the increase is complete - do not call this function again.',
  })
  async increaseLiquidity(
    walletClient: EVMWalletClient,
    parameters: IncreaseLiquidityParams,
  ): Promise<string> {
    try {
      // Set tokens and amounts in correct order
      const isOrderMatched =
        parameters.token0Address.toLowerCase() <
        parameters.token1Address.toLowerCase();

      const [token0, token1] = isOrderMatched
        ? [parameters.token0Address, parameters.token1Address]
        : [parameters.token1Address, parameters.token0Address];

      const [amount0Raw, amount1Raw] = isOrderMatched
        ? [parameters.amount0Desired, parameters.amount1Desired]
        : [parameters.amount1Desired, parameters.amount0Desired];

      const approvalHash0 = await walletClient.sendTransaction({
        to: token0 as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POSITION_MANAGER_ADDRESS, amount0Raw],
      });

      const approvalHash1 = await walletClient.sendTransaction({
        to: token1 as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POSITION_MANAGER_ADDRESS, amount1Raw],
      });

      // Calculate deadline as current time + deadline seconds
      const timestamp = Math.floor(Date.now() / 1000) + 60; // 60 seconds from now

      const hash = await walletClient.sendTransaction({
        to: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: 'increaseLiquidity',
        args: [
          {
            tokenId: parameters.tokenId,
            amount0Desired: amount0Raw,
            amount1Desired: amount1Raw,
            amount0Min: 0n,
            amount1Min: 0n,
            deadline: timestamp,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to increase liquidity: ${error}`);
    }
  }

  @Tool({
    name: 'kim_decrease_liquidity',
    description:
      'Decrease liquidity in an existing position by specifying a percentage (0-100). Returns a transaction hash on success. Once you get a transaction hash, the decrease is complete - do not call this function again.',
  })
  async decreaseLiquidity(
    walletClient: EVMWalletClient,
    parameters: DecreaseLiquidityParams,
  ): Promise<string> {
    try {
      // Get position info
      const positionResult = await walletClient.read({
        address: POSITION_MANAGER_ADDRESS as `0x${string}`,
        abi: POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [parameters.tokenId],
      });

      // biome-ignore lint/suspicious/noExplicitAny: value is any
      const position = (positionResult as { value: any[] }).value;

      const currentLiquidity = position[6];
      const liquidityToRemove =
        (currentLiquidity * BigInt(parameters.percentage)) / BigInt(100);

      // Set min amounts to 0 for now
      const amount0Min = 0n;
      const amount1Min = 0n;

      const timestamp = Math.floor(Date.now() / 1000) + 60;

      const hash = await walletClient.sendTransaction({
        to: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId: parameters.tokenId,
            liquidity: liquidityToRemove,
            amount0Min: amount0Min,
            amount1Min: amount1Min,
            deadline: timestamp,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to decrease liquidity: ${error}`);
    }
  }

  @Tool({
    name: 'kim_collect',
    description:
      'Collect all available tokens from a liquidity position. Can be rewards or tokens removed from a liquidity position. So, should be called after decreasing liquidity as well as on its own.',
  })
  async collect(
    walletClient: EVMWalletClient,
    parameters: CollectParams,
  ): Promise<string> {
    try {
      const recipient = walletClient.getAddress();
      // Use max uint128 to collect all available tokens
      const maxUint128 = BigInt(2 ** 128) - BigInt(1);

      const hash = await walletClient.sendTransaction({
        to: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: 'collect',
        args: [
          {
            tokenId: parameters.tokenId,
            recipient,
            amount0Max: maxUint128,
            amount1Max: maxUint128,
          },
        ],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to collect: ${error}`);
    }
  }

  @Tool({
    name: 'kim_burn',
    description:
      'Burn a liquidity position NFT after all tokens have been collected.',
  })
  async burn(
    walletClient: EVMWalletClient,
    parameters: BurnParams,
  ): Promise<string> {
    try {
      const hash = await walletClient.sendTransaction({
        to: POSITION_MANAGER_ADDRESS,
        abi: POSITION_MANAGER_ABI,
        functionName: 'burn',
        args: [parameters.tokenId],
      });

      return hash.hash;
    } catch (error) {
      throw new Error(`Failed to burn position: ${error}`);
    }
  }

  @Tool({
    name: 'kim_get_LP_tokens',
    description: 'Get all LP token positions (NFTs) owned by a user',
  })
  async getLPTokens(
    walletClient: EVMWalletClient,
    parameters: GetLPTokensParams,
  ): Promise<Array<{ tokenId: string; index: number }>> {
    try {
      console.log('\n=== Getting LP Tokens ===');
      console.log('User address:', parameters.userAddress);
      console.log('Position Manager address:', POSITION_MANAGER_ADDRESS);

      const balanceResult = await walletClient.read({
        address: POSITION_MANAGER_ADDRESS as `0x${string}`,
        abi: POSITION_MANAGER_ABI,
        functionName: 'balanceOf',
        args: [parameters.userAddress as `0x${string}`],
      });

      const balance = Number((balanceResult as { value: bigint }).value);
      console.log('Number of LP tokens:', balance);

      if (balance === 0) {
        console.log('User has no LP tokens');
        return [];
      }

      console.log('Fetching token IDs...');
      // Now get each token ID
      const tokenIds = await Promise.all(
        Array.from({ length: balance }, async (_, index) => {
          console.log(`\nFetching token at index ${index}...`);
          const tokenResult = await walletClient.read({
            address: POSITION_MANAGER_ADDRESS as `0x${string}`,
            abi: POSITION_MANAGER_ABI,
            functionName: 'tokenOfOwnerByIndex',
            args: [parameters.userAddress as `0x${string}`, BigInt(index)],
          });

          const tokenId = (tokenResult as { value: bigint }).value;
          console.log(`Token ID at index ${index}:`, tokenId.toString());

          return {
            tokenId: tokenId.toString(),
            index: index,
          };
        }),
      );

      console.log('\nAll token IDs:', tokenIds);
      return tokenIds;
    } catch (error) {
      console.error('Error in getLPTokens:', error);
      throw new Error(`Failed to get LP tokens: ${error}`);
    }
  }

  @Tool({
    name: 'kim_calculate_position_apy',
    description:
      'Calculate the APY for a liquidity position based on fees earned',
  })
  async calculatePositionAPY(
    walletClient: EVMWalletClient,
    parameters: CalculatePositionAPYParams,
  ): Promise<{
    apy: number;
    feesEarned: {
      token0Amount: string;
      token1Amount: string;
    };
    positionValue: string;
  }> {
    try {
      console.log('Calculating APY for position:', parameters.tokenId);

      // Get position details
      const positionResult = await walletClient.read({
        address: POSITION_MANAGER_ADDRESS as `0x${string}`,
        abi: POSITION_MANAGER_ABI,
        functionName: 'positions',
        args: [parameters.tokenId],
      });
      console.log('Position details:', positionResult.value);

      // Extract position data
      const position = positionResult.value;
      const token0 = position[2];
      const token1 = position[3];
      const liquidity = position[6];
      const feeGrowthInside0LastX128 = position[7];
      const feeGrowthInside1LastX128 = position[8];

      console.log('Extracted position data:', {
        token0,
        token1,
        liquidity: liquidity.toString(),
        feeGrowthInside0LastX128: feeGrowthInside0LastX128.toString(),
        feeGrowthInside1LastX128: feeGrowthInside1LastX128.toString(),
      });

      // Get pool address
      const poolAddressResult = await walletClient.read({
        address: FACTORY_ADDRESS as `0x${string}`,
        abi: KIM_FACTORY_ABI,
        functionName: 'poolByPair',
        args: [token0, token1],
      });
      const poolAddress = poolAddressResult.value as `0x${string}`;
      console.log('Pool address:', poolAddress);

      // Get current fee growth from pool
      const [
        currentFeeGrowth0,
        currentFeeGrowth1,
        token0Decimals,
        token1Decimals,
        globalStateResult,
      ] = await Promise.all([
        walletClient.read({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: 'totalFeeGrowth0Token',
        }),
        walletClient.read({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: 'totalFeeGrowth1Token',
        }),
        walletClient.read({
          address: token0,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
        walletClient.read({
          address: token1,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }),
        walletClient.read({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: 'globalState',
        }),
      ]);

      console.log('Fee and price data:', {
        currentFeeGrowth0: currentFeeGrowth0.value.toString(),
        currentFeeGrowth1: currentFeeGrowth1.value.toString(),
        token0Decimals: token0Decimals.value,
        token1Decimals: token1Decimals.value,
        globalState: globalStateResult.value,
      });

      // Calculate fees earned
      const feesEarned0 = this.calculateFeesEarned(
        currentFeeGrowth0.value as bigint,
        feeGrowthInside0LastX128 as bigint,
        liquidity as bigint,
        Number(token0Decimals.value),
      );
      const feesEarned1 = this.calculateFeesEarned(
        currentFeeGrowth1.value as bigint,
        feeGrowthInside1LastX128 as bigint,
        liquidity as bigint,
        Number(token1Decimals.value),
      );

      console.log('Calculated fees earned:', {
        feesEarned0,
        feesEarned1,
      });

      // Calculate position value in terms of token0
      const price = this.calculatePrice(
        globalStateResult.value as readonly unknown[],
      );
      console.log('Calculated price:', price);

      const positionValue = this.calculatePositionValue(
        liquidity as bigint,
        price,
        Number(token0Decimals.value),
        Number(token1Decimals.value),
      );

      // Calculate APY
      const daysElapsed = parameters.daysToConsider || 365;
      console.log('Days elapsed:', daysElapsed);

      // Calculate daily fee return
      const dailyFeeReturn = (feesEarned0 + feesEarned1 * price) / daysElapsed;

      // Annualize the return
      const annualizedReturn = dailyFeeReturn * 365;

      // Calculate APY
      const apy = (annualizedReturn / positionValue) * 100;

      console.log('APY calculation:', {
        daysElapsed,
        annualizedReturn,
        apy,
      });

      return {
        apy,
        feesEarned: {
          token0Amount: feesEarned0.toString(),
          token1Amount: feesEarned1.toString(),
        },
        positionValue: positionValue.toString(),
      };
    } catch (error) {
      console.error('Error calculating APY:', error);
      throw new Error(`Failed to calculate APY: ${error}`);
    }
  }

  // Helper function to calculate position value
  private calculatePositionValue(
    liquidity: bigint,
    price: number,
    token0Decimals: number,
    token1Decimals: number,
  ): number {
    try {
      // Convert liquidity to a more manageable number while preserving precision
      const liquidityDecimal = Number(liquidity);

      // Calculate amounts using the liquidity
      const amount0 = liquidityDecimal / Math.sqrt(price);
      const amount1 = liquidityDecimal * Math.sqrt(price);

      // Convert to token units
      const amount0Adjusted = amount0 / 10 ** token0Decimals;
      const amount1Adjusted = amount1 / 10 ** token1Decimals;

      // Calculate total value in terms of token0
      const totalValue = amount0Adjusted + amount1Adjusted * price;

      console.log('Position value calculation:', {
        liquidityDecimal,
        amount0,
        amount1,
        amount0Adjusted,
        amount1Adjusted,
        totalValue,
      });

      return totalValue;
    } catch (error) {
      console.error('Error in calculatePositionValue:', error);
      throw error;
    }
  }

  // Helper function to calculate fees earned
  private calculateFeesEarned(
    currentFeeGrowth: bigint,
    lastFeeGrowth: bigint,
    liquidity: bigint,
    decimals: number,
  ): number {
    try {
      const feeGrowthDelta = currentFeeGrowth - lastFeeGrowth;
      // Convert to decimal before division to prevent overflow
      const feesRaw = (Number(feeGrowthDelta) * Number(liquidity)) / 2 ** 128;
      const feesAdjusted = feesRaw / 10 ** decimals;

      console.log('Fee calculation:', {
        feeGrowthDelta: feeGrowthDelta.toString(),
        feesRaw,
        feesAdjusted,
      });

      return feesAdjusted;
    } catch (error) {
      console.error('Error in calculateFeesEarned:', error);
      throw error;
    }
  }

  // Calculate price from globalState
  private calculatePrice(globalState: readonly unknown[]): number {
    try {
      const sqrtPriceX96 = globalState[0] as bigint;
      const sqrtPrice = Number(sqrtPriceX96) / 2 ** 96;
      // Price is in terms of token1/token0
      const price = sqrtPrice * sqrtPrice;

      console.log('Price calculation:', {
        sqrtPriceX96: sqrtPriceX96.toString(),
        sqrtPrice,
        price,
      });

      return price;
    } catch (error) {
      console.error('Error in calculatePrice:', error);
      throw error;
    }
  }
}
