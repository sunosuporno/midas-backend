import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { BigNumber } from '@ethersproject/bignumber';
import JSBI from 'jsbi';
import {
  Pool,
  Position,
  Token,
  TickDataProvider,
} from '@cryptoalgebra/integral-sdk';
import { formatUnits } from 'viem';
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
} from './parameters';
import { BigintIsh } from '@cryptoalgebra/integral-sdk/dist/types/BigIntish';

const SWAP_ROUTER_ADDRESS = '0xAc48FcF1049668B285f3dC72483DF5Ae2162f7e8';
const POSITION_MANAGER_ADDRESS = '0x2e8614625226D26180aDf6530C3b1677d3D7cf10';
const FACTORY_ADDRESS = '0xB5F00c2C5f8821155D8ed27E31932CFD9DB3C5D5';
const CALCULATOR_ADDRESS = '0x6f8E2B58373aB12Be5f7c28658633dD27D689f0D';

// interface Token {
//   chainId: number;
//   address: string;
//   decimals: number;
//   symbol?: string;
//   name?: string;
// }

// interface TickDataProvider {
//   getTick(tick: number): Promise<{ liquidityNet: bigint }>;
//   nextInitializedTickWithinOneWord(
//     tick: number,
//     lte: boolean,
//   ): Promise<[number, boolean]>;
// }

// interface Pool {
//   token0: Token;
//   token1: Token;
//   fee: number;
//   sqrtRatioX96: bigint;
//   liquidity: bigint;
//   tickCurrent: number;
//   tickSpacing: number;
//   tickDataProvider: TickDataProvider;
// }

// interface Position {
//   pool: Pool;
//   tickLower: number;
//   tickUpper: number;
//   liquidity: bigint;
// }

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

      await walletClient.sendTransaction({
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

      await walletClient.sendTransaction({
        to: token0 as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [POSITION_MANAGER_ADDRESS, amount0Raw],
      });

      await walletClient.sendTransaction({
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
      const positionData = (positionResult as { value: any[] }).value;

      const currentLiquidity = positionData[6];
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

  // private async getTokenDetails(
  //   walletClient: EVMWalletClient,
  //   tokenAddress: string,
  //   chainId: number,
  // ): Promise<Token> {
  //   console.log('\n=== Getting Token Details ===');
  //   console.log('Token Address:', tokenAddress);
  //   console.log('Chain ID:', chainId);
  //   try {
  //     const [decimals, symbol, name] = await Promise.all([
  //       walletClient.read({
  //         address: tokenAddress as `0x${string}`,
  //         abi: ERC20_ABI,
  //         functionName: 'decimals',
  //       }),
  //       walletClient.read({
  //         address: tokenAddress as `0x${string}`,
  //         abi: ERC20_ABI,
  //         functionName: 'symbol',
  //       }),
  //       walletClient.read({
  //         address: tokenAddress as `0x${string}`,
  //         abi: ERC20_ABI,
  //         functionName: 'name',
  //       }),
  //     ]);

  //     const tokenDetails = {
  //       chainId,
  //       address: tokenAddress,
  //       decimals: Number(decimals.value),
  //       symbol: symbol.value as string,
  //       name: name.value as string,
  //     };
  //     console.log('Token Details:', tokenDetails);
  //     return tokenDetails;
  //   } catch (error) {
  //     console.error('Error getting token details:', error);
  //     throw error;
  //   }
  // }

  @Tool({
    name: 'kim_get_lp_tokens',
    description: 'Get all LP token positions for a user along with their APYs',
  })
  async getLPTokens(
    walletClient: EVMWalletClient,
    parameters: GetLPTokensParams,
  ): Promise<
    Array<{
      tokenId: string;
      apy: number;
      position: Position;
    }>
  > {
    try {
      // Get number of positions
      const balanceResult = await walletClient.read({
        address: POSITION_MANAGER_ADDRESS as `0x${string}`,
        abi: POSITION_MANAGER_ABI,
        functionName: 'balanceOf',
        args: [parameters.userAddress],
      });
      const balance = balanceResult.value as bigint;

      // Get all token IDs
      const tokenIds: string[] = [];
      for (let i = 0; i < Number(balance); i++) {
        const tokenIdResult = await walletClient.read({
          address: POSITION_MANAGER_ADDRESS as `0x${string}`,
          abi: POSITION_MANAGER_ABI,
          functionName: 'tokenOfOwnerByIndex',
          args: [parameters.userAddress, BigInt(i)],
        });
        tokenIds.push(tokenIdResult.value.toString());
      }

      // Get position details and calculate APY for each position
      const positions = await Promise.all(
        tokenIds.map(async (tokenId) => {
          // Get position data from contract
          const positionResult = await walletClient.read({
            address: POSITION_MANAGER_ADDRESS as `0x${string}`,
            abi: POSITION_MANAGER_ABI,
            functionName: 'positions',
            args: [BigInt(tokenId)],
          });
          const positionData = positionResult.value as any[];
          const chainId = await walletClient.getChain().id;

          // Create SDK Token instances
          const token0 = new Token(
            chainId,
            positionData[2],
            await this.getTokenDecimals(walletClient, positionData[2]),
          );
          const token1 = new Token(
            chainId,
            positionData[3],
            await this.getTokenDecimals(walletClient, positionData[3]),
          );

          const poolAddress = (
            await walletClient.read({
              address: POSITION_MANAGER_ADDRESS as `0x${string}`,
              abi: POSITION_MANAGER_ABI,
              functionName: 'pool',
              args: [BigInt(tokenId)],
            })
          ).value as `0x${string}`;

          // Create tick data provider
          const tickDataProvider: TickDataProvider = {
            getTick: async (tick: number) => {
              const result = await walletClient.read({
                address: poolAddress as `0x${string}`,
                abi: POOL_ABI,
                functionName: 'ticks',
                args: [tick],
              });
              return {
                liquidityNet: BigInt(result.value[1].toString()),
              };
            },
            nextInitializedTickWithinOneWord: async (
              tick: number,
              lte: boolean,
            ) => {
              const functionName = lte ? 'prevTickGlobal' : 'nextTickGlobal';
              const result = await walletClient.read({
                address: poolAddress as `0x${string}`,
                abi: POOL_ABI,
                functionName,
                args: [],
              });
              return [Number(result.value), true];
            },
          };

          // Create SDK Pool instance
          const pool = new Pool(
            token0,
            token1,
            Number(positionData[4]), // fee
            JSBI.BigInt(positionData[8].toString()), // sqrtPriceX96
            JSBI.BigInt(positionData[7].toString()), // liquidity
            Number(positionData[9]), // tickCurrent
            60, // tickSpacing - this is fixed for Algebra pools
            tickDataProvider,
          );

          // Create SDK Position instance with correct interface
          const position = new Position({
            pool,
            liquidity: JSBI.BigInt(positionData[7].toString()),
            tickLower: Number(positionData[5]),
            tickUpper: Number(positionData[6]),
          });
          // Calculate APY using SDK position data
          const apy = this.calculatePositionAPY(
            position,
            [
              {
                feesUSD: (await this.fetchPoolFeeData(poolAddress)).toString(),
              },
            ],
            await this.fetchNativeTokenPrice(),
          );

          return {
            tokenId,
            position,
            apy,
          };
        }),
      );

      return positions;
    } catch (error) {
      console.error('Error fetching LP tokens:', error);
      throw new Error(`Failed to fetch LP tokens: ${error}`);
    }
  }

  private calculatePositionAPY(
    position: Position,
    poolFeeData: { feesUSD: string }[],
    nativePrice: number,
  ): number {
    try {
      // Get pool's total liquidity from SDK
      const totalLiquidity = position.pool.liquidity;

      // Calculate liquidity ratio using SDK position
      const liquidityRelation =
        Number(position.liquidity) / Number(totalLiquidity);

      // Calculate daily fees
      const poolDayFees =
        poolFeeData && poolFeeData.length > 0 && Number(poolFeeData[0].feesUSD);

      if (!poolDayFees) return 0;

      // Annualize fees
      const yearFee = poolDayFees * 365;

      // Use SDK to get token amounts
      const { amount0, amount1 } = position.mintAmounts;

      // Get token prices from pool
      const token0Price = position.pool.token0Price;
      const token1Price = position.pool.token1Price;

      // Calculate TVL using SDK prices
      const tvl =
        Number(amount0.toString()) *
          Number(token0Price.toSignificant(6)) *
          nativePrice +
        Number(amount1.toString()) *
          Number(token1Price.toSignificant(6)) *
          nativePrice;

      if (!tvl) return 0;

      // Calculate APY
      return ((yearFee * liquidityRelation) / tvl) * 100;
    } catch (error) {
      console.error('Error calculating position APY:', error);
      return 0;
    }
  }

  private async getTokenDecimals(
    walletClient: EVMWalletClient,
    tokenAddress: string,
  ): Promise<number> {
    const decimalsResult = await walletClient.read({
      address: tokenAddress as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(decimalsResult.value);
  }

  private async fetchNativeTokenPrice(): Promise<number> {
    console.log('\n=== Fetching Native Token Price ===');
    try {
      const response = await fetch(
        'https://api.goldsky.com/api/public/project_clmqdcfcs3f6d2ptj3yp05ndz/subgraphs/Algebra-Kim/0.0.4/gn',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query { bundles { id maticPriceUSD } }`,
          }),
        },
      );
      const data = await response.json();
      const price = Number(data.data.bundles[0].maticPriceUSD);
      console.log('Native Token Price:', price);
      return price;
    } catch (error) {
      console.error('Error fetching native price:', error);
      throw error;
    }
  }

  private async fetchPoolFeeData(poolAddress: string): Promise<number> {
    console.log('\n=== Fetching Pool Fee Data ===');
    console.log('Pool Address:', poolAddress);
    try {
      const response = await fetch(
        'https://api.goldsky.com/api/public/project_clmqdcfcs3f6d2ptj3yp05ndz/subgraphs/Algebra-Kim/0.0.4/gn',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: `query PoolFeeData($poolId: String) {
              poolDayDatas(
                where: { pool: $poolId }
                orderBy: date
                orderDirection: desc
              ) {
                feesUSD
              }
            }`,
            variables: { poolId: poolAddress.toLowerCase() },
          }),
        },
      );
      const data = await response.json();
      const poolDayDatas = data.data.poolDayDatas;
      const fees =
        poolDayDatas.length > 0 ? Number(poolDayDatas[0].feesUSD) : 0;
      console.log('Pool Day Data Length:', poolDayDatas.length);
      console.log('Pool Fees USD:', fees);
      return fees;
    } catch (error) {
      console.error('Error fetching pool fee data:', error);
      throw error;
    }
  }
}
