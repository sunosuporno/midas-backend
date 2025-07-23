import { Injectable, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { getPoolConfig } from './config/pools.config';

export interface SwapData {
  id: string;
  amount0: string;
  amount1: string;
  blockTimestamp: string;
  tick: number;
  sqrtPriceX96: string;
  liquidity: string;
  transactionHash: string;
}

export interface VolumeBlockData {
  blockStart: number;
  blockEnd: number;
  wethVolume: number;
  usdcVolume: number;
  swapsCount: number;
  averageTick: number;
  period: 'morning' | 'afternoon' | 'night';
}

@Injectable()
export class AerodromeSubgraphService {
  private readonly subgraphUrl: string;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    // Get subgraph URL from pool config
    const wethUsdcPool = getPoolConfig('weth-usdc');
    this.subgraphUrl =
      wethUsdcPool?.subgraphUrl ||
      'https://gateway.thegraph.com/api/subgraphs/id/7zcFovqfFuJQU5ygitcnKjpU95YCEuXyKCBSnZrtSu4J';

    // Get API key from environment
    this.apiKey = this.configService.get<string>('GRAPH_API_KEY') || '';

    console.log('AerodromeSubgraphService initialized:', {
      subgraphUrl: this.subgraphUrl,
      hasApiKey: !!this.apiKey,
      apiKeyLength: this.apiKey.length,
      envKeys: Object.keys(process.env).filter((key) => key.includes('GRAPH')),
    });
  }

  /**
   * Make authenticated request to subgraph
   */
  private async makeSubgraphRequest(
    query: string,
    variables: any,
  ): Promise<any> {
    console.log('Making subgraph request:', {
      url: this.subgraphUrl,
      hasApiKey: !!this.apiKey,
      apiKeyPreview: this.apiKey ? `${this.apiKey.substring(0, 8)}...` : 'none',
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add API key using the correct Graph API format
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await axios.post(
      this.subgraphUrl,
      { query, variables },
      { headers },
    );

    if (response.data.errors) {
      throw new Error(
        `Subgraph query failed: ${JSON.stringify(response.data.errors)}`,
      );
    }

    return response.data;
  }

  /**
   * Get swaps in a specific tick range within a time period
   */
  async getSwapsInRange(
    tickLower: number,
    tickUpper: number,
    since: number,
    until?: number,
  ): Promise<SwapData[]> {
    try {
      console.log(
        `Fetching swaps in range ${tickLower} to ${tickUpper} from ${new Date(since * 1000).toISOString()} to ${until ? new Date(until * 1000).toISOString() : 'now'}`,
      );

      let allSwaps: SwapData[] = [];
      let skip = 0;
      const batchSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const query = `
          query GetSwapsInRange($tickLower: Int!, $tickUpper: Int!, $since: Int!, $until: Int, $skip: Int!, $first: Int!) {
            swaps(
              where: {
                tick_gte: $tickLower,
                tick_lte: $tickUpper,
                blockTimestamp_gte: $since
                ${until ? 'blockTimestamp_lt: $until' : ''}
              }
              orderBy: blockTimestamp
              orderDirection: desc
              first: $first
              skip: $skip
            ) {
              id
              amount0
              amount1
              blockTimestamp
              tick
              sqrtPriceX96
              liquidity
              transactionHash
            }
          }
        `;

        const variables = {
          tickLower,
          tickUpper,
          since,
          ...(until && { until }),
          skip,
          first: batchSize,
        };

        const data = await this.makeSubgraphRequest(query, variables);
        const swaps = data.data.swaps || [];

        if (swaps.length === 0) {
          hasMore = false;
        } else {
          allSwaps = allSwaps.concat(swaps);
          skip += batchSize;

          // If we got less than batchSize, we've reached the end
          if (swaps.length < batchSize) {
            hasMore = false;
          }
        }

        // Safety check to prevent infinite loops
        if (skip > 10000) {
          console.warn(
            `Reached safety limit of 10,000 swaps for range ${tickLower}-${tickUpper}, stopping pagination`,
          );
          hasMore = false;
        }
      }

      console.log(
        `Fetched ${allSwaps.length} swaps in range ${tickLower} to ${tickUpper}`,
      );

      // Validate the data - check for reasonable values
      const validSwaps = allSwaps.filter((swap) => {
        const amount0 = Math.abs(parseFloat(swap.amount0));
        const amount1 = Math.abs(parseFloat(swap.amount1));
        const tick = swap.tick; // tick is already a number

        // Basic validation
        return (
          amount0 > 0 &&
          amount1 > 0 &&
          tick >= tickLower &&
          tick <= tickUpper &&
          parseInt(swap.blockTimestamp) >= since &&
          (!until || parseInt(swap.blockTimestamp) < until)
        );
      });

      if (validSwaps.length !== allSwaps.length) {
        console.warn(
          `Filtered out ${allSwaps.length - validSwaps.length} invalid swaps from range query`,
        );
      }

      return validSwaps;
    } catch (error) {
      console.error('Error fetching swaps from subgraph:', error);
      throw new HttpException(
        `Failed to fetch swaps from subgraph: ${error.message}`,
        500,
      );
    }
  }

  /**
   * Get all swaps within a time period (for overall volume calculation)
   */
  async getSwapsInPool(since: number, until?: number): Promise<SwapData[]> {
    try {
      console.log(
        `Fetching all swaps from ${new Date(since * 1000).toISOString()} to ${until ? new Date(until * 1000).toISOString() : 'now'}`,
      );

      let allSwaps: SwapData[] = [];
      let skip = 0;
      const batchSize = 1000;
      let hasMore = true;

      while (hasMore) {
        const query = `
          query GetSwapsInPool($since: Int!, $until: Int, $skip: Int!, $first: Int!) {
            swaps(
              where: {
                blockTimestamp_gte: $since
                ${until ? 'blockTimestamp_lt: $until' : ''}
              }
              orderBy: blockTimestamp
              orderDirection: desc
              first: $first
              skip: $skip
            ) {
              id
              amount0
              amount1
              blockTimestamp
              tick
              sqrtPriceX96
              liquidity
              transactionHash
            }
          }
        `;

        const variables = {
          since,
          ...(until && { until }),
          skip,
          first: batchSize,
        };

        const data = await this.makeSubgraphRequest(query, variables);
        const swaps = data.data.swaps || [];

        if (swaps.length === 0) {
          hasMore = false;
        } else {
          allSwaps = allSwaps.concat(swaps);
          skip += batchSize;

          // If we got less than batchSize, we've reached the end
          if (swaps.length < batchSize) {
            hasMore = false;
          }
        }

        // Safety check to prevent infinite loops
        if (skip > 10000) {
          console.warn(
            'Reached safety limit of 10,000 swaps, stopping pagination',
          );
          hasMore = false;
        }
      }

      console.log(
        `Fetched ${allSwaps.length} total swaps for period ${since}-${until || 'now'}`,
      );

      // Validate the data - check for reasonable values
      const validSwaps = allSwaps.filter((swap) => {
        const amount0 = Math.abs(parseFloat(swap.amount0));
        const amount1 = Math.abs(parseFloat(swap.amount1));

        // Basic validation
        return (
          amount0 > 0 &&
          amount1 > 0 &&
          parseInt(swap.blockTimestamp) >= since &&
          (!until || parseInt(swap.blockTimestamp) < until)
        );
      });

      if (validSwaps.length !== allSwaps.length) {
        console.warn(
          `Filtered out ${allSwaps.length - validSwaps.length} invalid swaps from pool query`,
        );
      }

      return validSwaps;
    } catch (error) {
      console.error('Error fetching pool swaps from subgraph:', error);
      throw new HttpException(
        `Failed to fetch pool swaps from subgraph: ${error.message}`,
        500,
      );
    }
  }

  /**
   * Calculate WETH and USDC volumes separately from swap data
   */
  calculateVolumes(swaps: SwapData[]): {
    wethVolume: number;
    usdcVolume: number;
  } {
    return swaps.reduce(
      (totals, swap) => {
        // For WETH/USDC pool, amount0 is WETH (18 decimals), amount1 is USDC (6 decimals)
        const amount0Abs = Math.abs(parseFloat(swap.amount0)); // WETH in wei
        const amount1Abs = Math.abs(parseFloat(swap.amount1)); // USDC in smallest units

        return {
          wethVolume: totals.wethVolume + amount0Abs,
          usdcVolume: totals.usdcVolume + amount1Abs,
        };
      },
      { wethVolume: 0, usdcVolume: 0 },
    );
  }

  /**
   * Calculate average tick from swap data
   */
  calculateAverageTick(swaps: SwapData[]): number {
    if (swaps.length === 0) return 0;

    const totalTick = swaps.reduce((sum, swap) => sum + swap.tick, 0);
    return totalTick / swaps.length;
  }

  /**
   * Determine period based on GMT+5.30 timezone
   */
  getPeriodFromTimestamp(timestamp: number): 'morning' | 'afternoon' | 'night' {
    const date = new Date(timestamp * 1000);
    const hour = date.getUTCHours() + 5.5; // Convert to GMT+5.30

    if (hour >= 8 && hour < 16) return 'morning';
    if (hour >= 16 && hour < 24) return 'afternoon';
    return 'night';
  }

  /**
   * Calculate 8-hour block timestamps
   */
  calculateBlockTimestamps(timestamp: number): {
    blockStart: number;
    blockEnd: number;
  } {
    const blockStart = Math.floor(timestamp / (8 * 60 * 60)) * (8 * 60 * 60);
    const blockEnd = blockStart + 8 * 60 * 60;

    return { blockStart, blockEnd };
  }
}
