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
   * Get estimated swap count to determine if pagination is needed
   */
  private async getEstimatedSwapCount(
    tickLower: number,
    tickUpper: number,
    since: number,
    until?: number,
  ): Promise<number | 'more_than_1000'> {
    try {
      const query = `
        query GetEstimatedCount($tickLower: Int!, $tickUpper: Int!, $since: Int!, $until: Int) {
          swaps(
            where: {
              tick_gte: $tickLower,
              tick_lte: $tickUpper,
              blockTimestamp_gte: $since
              ${until ? 'blockTimestamp_lt: $until' : ''}
            }
            orderBy: blockTimestamp
            orderDirection: desc
            first: 1000
          ) {
            id
          }
        }
      `;

      const variables = {
        tickLower,
        tickUpper,
        since,
        ...(until && { until }),
      };

      const data = await this.makeSubgraphRequest(query, variables);
      const swaps = data.data.swaps || [];

      // If we got exactly 1000, there might be more
      if (swaps.length === 1000) {
        console.log(
          `Found exactly 1000 swaps - there might be more. Using pagination.`,
        );
        return 'more_than_1000';
      } else {
        console.log(`Found ${swaps.length} swaps - exact count.`);
        return swaps.length;
      }
    } catch (error) {
      console.error('Error getting estimated swap count:', error);
      // If count query fails, assume we need pagination to be safe
      return 'more_than_1000';
    }
  }

  /**
   * Get swaps in a specific tick range within a time period
   * Uses intelligent pagination to get ALL data safely
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

      // First, check if we need pagination
      const estimatedCount = await this.getEstimatedSwapCount(
        tickLower,
        tickUpper,
        since,
        until,
      );

      // If count is small, use single query
      if (typeof estimatedCount === 'number' && estimatedCount < 1000) {
        console.log('Using single query approach - small dataset');
        return await this.getSwapsInRangeSingleQuery(
          tickLower,
          tickUpper,
          since,
          until,
        );
      }

      // If count is large or unknown, use pagination
      console.log('Using pagination approach - large dataset');
      return await this.getSwapsInRangeWithPagination(
        tickLower,
        tickUpper,
        since,
        until,
      );
    } catch (error) {
      console.error('Error fetching swaps from subgraph:', error);
      throw new HttpException(
        `Failed to fetch swaps from subgraph: ${error.message}`,
        500,
      );
    }
  }

  /**
   * Get swaps in range using a single query (for small datasets)
   */
  private async getSwapsInRangeSingleQuery(
    tickLower: number,
    tickUpper: number,
    since: number,
    until?: number,
  ): Promise<SwapData[]> {
    const query = `
      query GetSwapsInRange($tickLower: Int!, $tickUpper: Int!, $since: Int!, $until: Int) {
        swaps(
          where: {
            tick_gte: $tickLower,
            tick_lte: $tickUpper,
            blockTimestamp_gte: $since
            ${until ? 'blockTimestamp_lt: $until' : ''}
          }
          orderBy: blockTimestamp
          orderDirection: desc
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
    };

    const data = await this.makeSubgraphRequest(query, variables);
    const swaps = data.data.swaps || [];

    console.log(
      `Fetched ${swaps.length} swaps in range ${tickLower} to ${tickUpper} (single query)`,
    );

    // Validate the data
    return this.validateSwaps(swaps, tickLower, tickUpper, since, until);
  }

  /**
   * Get swaps in range using time-based chunking (for very large datasets)
   */
  private async getSwapsInRangeWithPagination(
    tickLower: number,
    tickUpper: number,
    since: number,
    until?: number,
  ): Promise<SwapData[]> {
    const endTime = until || Math.floor(Date.now() / 1000);
    const timeRange = endTime - since;

    console.log(
      `Large dataset detected. Time range: ${timeRange} seconds (${(timeRange / 3600).toFixed(2)} hours)`,
    );

    // If we hit the skip limit, we need to chunk by time
    // Calculate optimal chunk size to get ~4000 swaps per chunk (safe margin)
    const estimatedSwapsPerSecond = 5000 / timeRange; // Based on hitting the limit
    const targetSwapsPerChunk = 4000; // Safe margin below 5000 limit
    const chunkSize = Math.max(
      300,
      Math.floor(targetSwapsPerChunk / estimatedSwapsPerSecond),
    ); // Minimum 5 minutes

    console.log(
      `Using time-based chunking: ${chunkSize} second chunks (${(chunkSize / 60).toFixed(1)} minutes)`,
    );

    let allSwaps: SwapData[] = [];

    for (
      let chunkStart = since;
      chunkStart < endTime;
      chunkStart += chunkSize
    ) {
      const chunkEnd = Math.min(chunkStart + chunkSize, endTime);

      console.log(
        `Fetching chunk: ${new Date(chunkStart * 1000).toISOString()} to ${new Date(chunkEnd * 1000).toISOString()}`,
      );

      // For each time chunk, use pagination to get all swaps
      const chunkSwaps = await this.getSwapsInRangeForTimeChunk(
        tickLower,
        tickUpper,
        chunkStart,
        chunkEnd,
      );

      allSwaps = allSwaps.concat(chunkSwaps);

      // Add delay between chunks to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Remove duplicates based on swap ID
    const uniqueSwaps = this.removeDuplicateSwaps(allSwaps);

    console.log(
      `Fetched ${allSwaps.length} total swaps (${uniqueSwaps.length} unique) in range ${tickLower} to ${tickUpper} (time-chunked)`,
    );

    // Validate the data
    return this.validateSwaps(uniqueSwaps, tickLower, tickUpper, since, until);
  }

  /**
   * Get swaps in range for a specific time chunk using pagination
   * If we hit the skip limit, we need to subdivide the time chunk further
   */
  private async getSwapsInRangeForTimeChunk(
    tickLower: number,
    tickUpper: number,
    since: number,
    until: number,
    recursionDepth: number = 0,
  ): Promise<SwapData[]> {
    let allSwaps: SwapData[] = [];
    let skip = 0;
    const batchSize = 1000; // Subgraph's max limit
    let hasMore = true;
    let hitSkipLimit = false;

    while (hasMore) {
      const query = `
        query GetSwapsInRangeTimeChunk($tickLower: Int!, $tickUpper: Int!, $since: Int!, $until: Int!, $skip: Int!, $first: Int!) {
          swaps(
            where: {
              tick_gte: $tickLower,
              tick_lte: $tickUpper,
              blockTimestamp_gte: $since,
              blockTimestamp_lt: $until
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
        until,
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

      // Check if we hit the skip limit
      if (skip >= 5000) {
        console.warn(
          `Hit subgraph skip limit of 5000 for time chunk ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}. Need to subdivide time chunk.`,
        );
        hitSkipLimit = true;
        hasMore = false;
      }

      // Add small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If we hit the skip limit, we need to subdivide this time chunk
    if (hitSkipLimit) {
      // Safety check: prevent infinite recursion
      if (recursionDepth >= 5) {
        console.error(
          `Maximum recursion depth (5) reached for time chunk ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}. Returning partial data.`,
        );
        return allSwaps;
      }

      console.log(
        `Subdividing time chunk due to skip limit. Current chunk: ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}`,
      );

      const timeRange = until - since;
      const newChunkSize = Math.max(60, Math.floor(timeRange / 4)); // Subdivide into 4 smaller chunks, minimum 1 minute

      console.log(`Subdividing into ${newChunkSize} second chunks`);

      let subdividedSwaps: SwapData[] = [];

      for (
        let chunkStart = since;
        chunkStart < until;
        chunkStart += newChunkSize
      ) {
        const chunkEnd = Math.min(chunkStart + newChunkSize, until);

        console.log(
          `Fetching subdivided chunk: ${new Date(chunkStart * 1000).toISOString()}-${new Date(chunkEnd * 1000).toISOString()}`,
        );

        // Recursively call this method for the smaller time chunk
        const chunkSwaps = await this.getSwapsInRangeForTimeChunk(
          tickLower,
          tickUpper,
          chunkStart,
          chunkEnd,
          recursionDepth + 1,
        );

        subdividedSwaps = subdividedSwaps.concat(chunkSwaps);

        // Add delay between subdivided chunks
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Combine with what we already got before hitting the limit
      allSwaps = allSwaps.concat(subdividedSwaps);
    }

    return allSwaps;
  }

  /**
   * Remove duplicate swaps based on swap ID
   */
  private removeDuplicateSwaps(swaps: SwapData[]): SwapData[] {
    const seen = new Set<string>();
    return swaps.filter((swap) => {
      if (seen.has(swap.id)) {
        return false;
      }
      seen.add(swap.id);
      return true;
    });
  }

  /**
   * Get all swaps within a time period (for overall volume calculation)
   * Uses intelligent pagination to get ALL data safely
   */
  async getSwapsInPool(since: number, until?: number): Promise<SwapData[]> {
    try {
      console.log(
        `Fetching all swaps from ${new Date(since * 1000).toISOString()} to ${until ? new Date(until * 1000).toISOString() : 'now'}`,
      );

      // First, check if we need pagination
      const estimatedCount = await this.getEstimatedPoolSwapCount(since, until);

      // If count is small, use single query
      if (typeof estimatedCount === 'number' && estimatedCount < 1000) {
        console.log('Using single query approach - small dataset');
        return await this.getSwapsInPoolSingleQuery(since, until);
      }

      // If count is large or unknown, use pagination
      console.log('Using pagination approach - large dataset');
      return await this.getSwapsInPoolWithPagination(since, until);
    } catch (error) {
      console.error('Error fetching pool swaps from subgraph:', error);
      throw new HttpException(
        `Failed to fetch pool swaps from subgraph: ${error.message}`,
        500,
      );
    }
  }

  /**
   * Get estimated swap count for entire pool
   */
  private async getEstimatedPoolSwapCount(
    since: number,
    until?: number,
  ): Promise<number | 'more_than_1000'> {
    try {
      const query = `
        query GetEstimatedPoolCount($since: Int!, $until: Int) {
          swaps(
            where: {
              blockTimestamp_gte: $since
              ${until ? 'blockTimestamp_lt: $until' : ''}
            }
            orderBy: blockTimestamp
            orderDirection: desc
            first: 1000
          ) {
            id
          }
        }
      `;

      const variables = {
        since,
        ...(until && { until }),
      };

      const data = await this.makeSubgraphRequest(query, variables);
      const swaps = data.data.swaps || [];

      // If we got exactly 1000, there might be more
      if (swaps.length === 1000) {
        console.log(
          `Found exactly 1000 pool swaps - there might be more. Using pagination.`,
        );
        return 'more_than_1000';
      } else {
        console.log(`Found ${swaps.length} pool swaps - exact count.`);
        return swaps.length;
      }
    } catch (error) {
      console.error('Error getting estimated pool swap count:', error);
      // If count query fails, assume we need pagination to be safe
      return 'more_than_1000';
    }
  }

  /**
   * Get swaps in pool using a single query (for small datasets)
   */
  private async getSwapsInPoolSingleQuery(
    since: number,
    until?: number,
  ): Promise<SwapData[]> {
    const query = `
      query GetSwapsInPool($since: Int!, $until: Int) {
        swaps(
          where: {
            blockTimestamp_gte: $since
            ${until ? 'blockTimestamp_lt: $until' : ''}
          }
          orderBy: blockTimestamp
          orderDirection: desc
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
    };

    const data = await this.makeSubgraphRequest(query, variables);
    const swaps = data.data.swaps || [];

    console.log(
      `Fetched ${swaps.length} total swaps for period ${since}-${until || 'now'} (single query)`,
    );

    // Validate the data
    return this.validateSwaps(swaps, undefined, undefined, since, until);
  }

  /**
   * Get swaps in pool using time-based chunking (for very large datasets)
   */
  private async getSwapsInPoolWithPagination(
    since: number,
    until?: number,
  ): Promise<SwapData[]> {
    const endTime = until || Math.floor(Date.now() / 1000);
    const timeRange = endTime - since;

    console.log(
      `Large pool dataset detected. Time range: ${timeRange} seconds (${(timeRange / 3600).toFixed(2)} hours)`,
    );

    // Calculate optimal chunk size to get ~4000 swaps per chunk (safe margin)
    const estimatedSwapsPerSecond = 5000 / timeRange; // Based on hitting the limit
    const targetSwapsPerChunk = 4000; // Safe margin below 5000 limit
    const chunkSize = Math.max(
      300,
      Math.floor(targetSwapsPerChunk / estimatedSwapsPerSecond),
    ); // Minimum 5 minutes

    console.log(
      `Using time-based chunking: ${chunkSize} second chunks (${(chunkSize / 60).toFixed(1)} minutes)`,
    );

    let allSwaps: SwapData[] = [];

    for (
      let chunkStart = since;
      chunkStart < endTime;
      chunkStart += chunkSize
    ) {
      const chunkEnd = Math.min(chunkStart + chunkSize, endTime);

      console.log(
        `Fetching pool chunk: ${new Date(chunkStart * 1000).toISOString()} to ${new Date(chunkEnd * 1000).toISOString()}`,
      );

      // For each time chunk, use pagination to get all swaps
      const chunkSwaps = await this.getSwapsInPoolForTimeChunk(
        chunkStart,
        chunkEnd,
      );

      allSwaps = allSwaps.concat(chunkSwaps);

      // Add delay between chunks to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Remove duplicates based on swap ID
    const uniqueSwaps = this.removeDuplicateSwaps(allSwaps);

    console.log(
      `Fetched ${allSwaps.length} total swaps (${uniqueSwaps.length} unique) for period ${since}-${endTime} (time-chunked)`,
    );

    // Validate the data
    return this.validateSwaps(uniqueSwaps, undefined, undefined, since, until);
  }

  /**
   * Get swaps in pool for a specific time chunk using pagination
   * If we hit the skip limit, we need to subdivide the time chunk further
   */
  private async getSwapsInPoolForTimeChunk(
    since: number,
    until: number,
    recursionDepth: number = 0,
  ): Promise<SwapData[]> {
    let allSwaps: SwapData[] = [];
    let skip = 0;
    const batchSize = 1000; // Subgraph's max limit
    let hasMore = true;
    let hitSkipLimit = false;

    while (hasMore) {
      const query = `
        query GetSwapsInPoolTimeChunk($since: Int!, $until: Int!, $skip: Int!, $first: Int!) {
          swaps(
            where: {
              blockTimestamp_gte: $since,
              blockTimestamp_lt: $until
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
        until,
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

      // Check if we hit the skip limit
      if (skip >= 5000) {
        console.warn(
          `Hit subgraph skip limit of 5000 for pool time chunk ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}. Need to subdivide time chunk.`,
        );
        hitSkipLimit = true;
        hasMore = false;
      }

      // Add small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // If we hit the skip limit, we need to subdivide this time chunk
    if (hitSkipLimit) {
      // Safety check: prevent infinite recursion
      if (recursionDepth >= 5) {
        console.error(
          `Maximum recursion depth (5) reached for pool time chunk ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}. Returning partial data.`,
        );
        return allSwaps;
      }

      console.log(
        `Subdividing pool time chunk due to skip limit. Current chunk: ${new Date(since * 1000).toISOString()}-${new Date(until * 1000).toISOString()}`,
      );

      const timeRange = until - since;
      const newChunkSize = Math.max(60, Math.floor(timeRange / 4)); // Subdivide into 4 smaller chunks, minimum 1 minute

      console.log(`Subdividing into ${newChunkSize} second chunks`);

      let subdividedSwaps: SwapData[] = [];

      for (
        let chunkStart = since;
        chunkStart < until;
        chunkStart += newChunkSize
      ) {
        const chunkEnd = Math.min(chunkStart + newChunkSize, until);

        console.log(
          `Fetching subdivided pool chunk: ${new Date(chunkStart * 1000).toISOString()}-${new Date(chunkEnd * 1000).toISOString()}`,
        );

        // Recursively call this method for the smaller time chunk
        const chunkSwaps = await this.getSwapsInPoolForTimeChunk(
          chunkStart,
          chunkEnd,
          recursionDepth + 1,
        );

        subdividedSwaps = subdividedSwaps.concat(chunkSwaps);

        // Add delay between subdivided chunks
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      // Combine with what we already got before hitting the limit
      allSwaps = allSwaps.concat(subdividedSwaps);
    }

    return allSwaps;
  }

  /**
   * Validate swaps data and filter out invalid entries
   */
  private validateSwaps(
    swaps: SwapData[],
    tickLower?: number,
    tickUpper?: number,
    since?: number,
    until?: number,
  ): SwapData[] {
    const validSwaps = swaps.filter((swap) => {
      const amount0 = Math.abs(parseFloat(swap.amount0));
      const amount1 = Math.abs(parseFloat(swap.amount1));
      const tick = swap.tick;
      const timestamp = parseInt(swap.blockTimestamp);

      // Basic validation
      const isValidAmount = amount0 > 0 && amount1 > 0;
      const isValidTick =
        tickLower === undefined ||
        tickUpper === undefined ||
        (tick >= tickLower && tick <= tickUpper);
      const isValidTime =
        since === undefined ||
        until === undefined ||
        (timestamp >= since && (!until || timestamp < until));

      if (!isValidTime && since !== undefined) {
        console.warn(
          `⚠️ Swap ${swap.id} outside time range: ${new Date(timestamp * 1000).toISOString()} (expected ${new Date(since * 1000).toISOString()} to ${until ? new Date(until * 1000).toISOString() : 'now'})`,
        );
      }

      return isValidAmount && isValidTick && isValidTime;
    });

    if (validSwaps.length !== swaps.length) {
      console.warn(
        `Filtered out ${swaps.length - validSwaps.length} invalid swaps`,
      );
    }

    return validSwaps;
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
