/**
 * Aerodrome Volume Block Scheduler Service
 *
 * This service runs every 8 hours to collect volume data from the subgraph
 * and store it in 8-hour blocks with 7-day rolling history.
 *
 * Schedule: Runs at 8am, 4pm, and 12am GMT+5.30 (3 times per day)
 * This translates to 2:30am, 10:30am, 6:30pm UTC
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AerodromeSubgraphService } from './aerodrome/subgraph.service';
import {
  VolumeBlock,
  VolumeBlockDocument,
} from './aerodrome/schemas/volume-block.schema';

@Injectable()
export class AerodromeVolumeBlockCronService implements OnModuleInit {
  private isRunning = false;
  private lastRunTime: Date | null = null;
  private lastRunDuration: number | null = null;
  private schedulerInterval: NodeJS.Timeout | null = null;
  private isInitialized = false;

  constructor(
    private configService: ConfigService,
    private subgraphService: AerodromeSubgraphService,
    @InjectModel(VolumeBlock.name)
    private volumeBlockModel: Model<VolumeBlockDocument>,
  ) {}

  async onModuleInit() {
    console.log('=== AERODROME VOLUME BLOCK SCHEDULER SERVICE INITIALIZED ===');
    console.log('Volume block scheduler will run every 8 hours');
    console.log(
      'Schedule: 8am, 4pm, 12am GMT+5.30 (2:30am, 10:30am, 6:30pm UTC)',
    );

    // Initialize the scheduler without running immediately
    this.initializeScheduler();
  }

  private initializeScheduler() {
    if (this.isInitialized) {
      console.log('Scheduler already initialized, skipping...');
      return;
    }

    this.isInitialized = true;

    // Calculate time until next scheduled run
    const nextRunTime = this.getNextScheduledRunTime();
    const timeUntilNextRun = nextRunTime.getTime() - Date.now();

    console.log(`Next scheduled run: ${nextRunTime.toISOString()}`);
    console.log(
      `Time until next run: ${Math.round(timeUntilNextRun / 1000 / 60)} minutes`,
    );

    // Schedule the first run
    setTimeout(() => {
      this.runVolumeBlockCollection();
      this.scheduleNextRuns();
    }, timeUntilNextRun);
  }

  private getNextScheduledRunTime(): Date {
    const now = new Date();
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();

    // Scheduled times in UTC: 2:30am, 10:30am, 6:30pm
    const scheduledTimes = [2.5, 10.5, 18.5]; // hours in decimal

    // Find the next scheduled time
    let nextHour = scheduledTimes[0];
    for (const time of scheduledTimes) {
      if (
        utcHours < time ||
        (utcHours === Math.floor(time) && utcMinutes < 30)
      ) {
        nextHour = time;
        break;
      }
    }

    // If we've passed all times today, schedule for tomorrow
    if (nextHour <= utcHours) {
      nextHour = scheduledTimes[0];
      now.setUTCDate(now.getUTCDate() + 1);
    }

    const nextRun = new Date(now);
    nextRun.setUTCHours(Math.floor(nextHour), 30, 0, 0);

    return nextRun;
  }

  private scheduleNextRuns() {
    // Clear any existing interval
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
    }

    // Schedule runs every 8 hours (28800000 ms)
    this.schedulerInterval = setInterval(
      () => {
        this.runVolumeBlockCollection();
      },
      8 * 60 * 60 * 1000,
    );

    console.log('Scheduled recurring runs every 8 hours');
  }

  private async runVolumeBlockCollection() {
    if (this.isRunning) {
      console.log(
        '⚠️ Volume block collection already in progress, skipping this run',
      );
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.lastRunTime = new Date();

    try {
      console.log('=== AERODROME VOLUME BLOCK COLLECTION STARTED ===');
      console.log('Current time:', new Date().toISOString());

      const result = await this.collectVolumeBlocks();

      const endTime = Date.now();
      const duration = endTime - startTime;
      this.lastRunDuration = duration;

      console.log('=== AERODROME VOLUME BLOCK COLLECTION COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Result:', result);
    } catch (error) {
      console.error('=== AERODROME VOLUME BLOCK COLLECTION FAILED ===');
      console.error('Error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async collectVolumeBlocks(): Promise<{
    success: boolean;
    message: string;
    results: {
      poolsProcessed: number;
      blocksCreated: number;
      blocksUpdated: number;
      errors: string[];
    };
  }> {
    try {
      console.log('=== COLLECTING VOLUME BLOCKS ===');
      const startTime = Date.now();

      const results = {
        poolsProcessed: 1,
        blocksCreated: 0,
        blocksUpdated: 0,
        errors: [] as string[],
      };

      try {
        console.log('Processing WETH/USDC pool volume block');
        const poolResult = await this.processPoolVolumeBlock();
        results.blocksCreated += poolResult.blocksCreated;
        results.blocksUpdated += poolResult.blocksUpdated;
      } catch (error) {
        results.errors.push(`WETH/USDC pool: ${error.message}`);
        console.error('❌ Error processing WETH/USDC pool:', error);
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('=== VOLUME BLOCK COLLECTION COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Volume block collection completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== VOLUME BLOCK COLLECTION FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Volume block collection failed: ${error.message}`,
        results: {
          poolsProcessed: 0,
          blocksCreated: 0,
          blocksUpdated: 0,
          errors: [error.message],
        },
      };
    }
  }

  private async processPoolVolumeBlock(): Promise<{
    blocksCreated: number;
    blocksUpdated: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const { blockStart, blockEnd } =
      this.subgraphService.calculateBlockTimestamps(now);
    const period = this.subgraphService.getPeriodFromTimestamp(blockStart);

    console.log('Processing volume block for WETH/USDC pool:');
    console.log(
      `  Block: ${new Date(blockStart * 1000).toISOString()} - ${new Date(blockEnd * 1000).toISOString()}`,
    );
    console.log(`  Period: ${period}`);

    // Get swaps for the last 8 hours
    const swaps = await this.subgraphService.getSwapsInPool(
      blockStart,
      blockEnd,
    );

    console.log(`  Found ${swaps.length} swaps in the last 8 hours`);

    // Calculate WETH and USDC volumes separately
    const { wethVolume, usdcVolume } =
      this.subgraphService.calculateVolumes(swaps);
    const averageTick = this.subgraphService.calculateAverageTick(swaps);

    // Get or create volume block document for this period
    let volumeBlock = await this.volumeBlockModel.findOne({
      poolAddress: 'weth-usdc',
      period,
    });

    // Create history entry
    const historyEntry = {
      blockStart,
      blockEnd,
      blockStartTime: new Date(blockStart * 1000).toISOString(),
      blockEndTime: new Date(blockEnd * 1000).toISOString(),
      wethVolume,
      usdcVolume,
      swapsCount: swaps.length,
      averageTick,
      period,
      createdAt: new Date(),
    };

    if (!volumeBlock) {
      // Create new volume block document for this period
      volumeBlock = new this.volumeBlockModel({
        poolAddress: 'weth-usdc',
        period,
        wethVolume, // For first entry, use the current block values
        usdcVolume,
        swapsCount: swaps.length,
        averageTick,
        volumeHistory: [historyEntry],
        lastUpdated: new Date(),
      });
    } else {
      // Add to existing volume block history
      volumeBlock.volumeHistory.push(historyEntry);

      // Keep only last 7 entries (7 days for this period)
      if (volumeBlock.volumeHistory.length > 7) {
        volumeBlock.volumeHistory = volumeBlock.volumeHistory.slice(-7);
      }

      // Calculate moving averages (7-day average)
      const totalWethVolume = volumeBlock.volumeHistory.reduce(
        (sum, entry) => sum + entry.wethVolume,
        0,
      );
      const totalUsdcVolume = volumeBlock.volumeHistory.reduce(
        (sum, entry) => sum + entry.usdcVolume,
        0,
      );
      const totalSwapsCount = volumeBlock.volumeHistory.reduce(
        (sum, entry) => sum + entry.swapsCount,
        0,
      );
      const totalAverageTick = volumeBlock.volumeHistory.reduce(
        (sum, entry) => sum + entry.averageTick,
        0,
      );

      const historyLength = volumeBlock.volumeHistory.length;

      // Update existing volume block for this period with moving averages
      volumeBlock.wethVolume = totalWethVolume / historyLength;
      volumeBlock.usdcVolume = totalUsdcVolume / historyLength;
      volumeBlock.swapsCount = Math.round(totalSwapsCount / historyLength);
      volumeBlock.averageTick = totalAverageTick / historyLength;
      volumeBlock.lastUpdated = new Date();
    }

    await volumeBlock.save();

    console.log(
      `  ✅ Volume block saved for ${period}: WETH ${volumeBlock.wethVolume.toFixed(2)}, USDC ${volumeBlock.usdcVolume.toFixed(2)}, swaps ${volumeBlock.swapsCount}, latest block: ${swaps.length} swaps`,
    );

    return {
      blocksCreated: volumeBlock.isNew ? 1 : 0,
      blocksUpdated: volumeBlock.isNew ? 0 : 1,
    };
  }

  /**
   * Manual trigger for testing
   */
  async manualTriggerVolumeBlockCollection(): Promise<{
    success: boolean;
    message: string;
    results: {
      poolsProcessed: number;
      blocksCreated: number;
      blocksUpdated: number;
      errors: string[];
    };
  }> {
    console.log('=== MANUAL VOLUME BLOCK COLLECTION TRIGGERED ===');
    return await this.collectVolumeBlocks();
  }

  /**
   * Get volume block data for WETH/USDC pool (all periods)
   */
  async getVolumeBlockData(): Promise<VolumeBlock[]> {
    return await this.volumeBlockModel
      .find({
        poolAddress: 'weth-usdc',
      })
      .sort({ period: 1 });
  }

  /**
   * Clear all volume block data (for schema migration)
   */
  async clearVolumeBlockData(): Promise<{
    success: boolean;
    message: string;
    deletedCount: number;
  }> {
    try {
      const result = await this.volumeBlockModel.deleteMany({
        poolAddress: 'weth-usdc',
      });

      console.log(`Cleared ${result.deletedCount} volume block documents`);

      return {
        success: true,
        message: `Cleared ${result.deletedCount} volume block documents`,
        deletedCount: result.deletedCount,
      };
    } catch (error) {
      console.error('Error clearing volume block data:', error);
      return {
        success: false,
        message: `Failed to clear volume block data: ${error.message}`,
        deletedCount: 0,
      };
    }
  }

  /**
   * Get average WETH and USDC volumes for a specific period
   */
  async getAverageVolumesForPeriod(
    period: 'morning' | 'afternoon' | 'night',
    days: number = 7,
  ): Promise<{ wethVolume: number; usdcVolume: number }> {
    const volumeBlock = await this.volumeBlockModel.findOne({
      poolAddress: 'weth-usdc',
      period,
    });

    if (!volumeBlock || !volumeBlock.volumeHistory) {
      return { wethVolume: 0, usdcVolume: 0 };
    }

    // Get last N days of data
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const recentHistory = volumeBlock.volumeHistory.filter(
      (entry) => entry.createdAt >= cutoffDate,
    );

    if (recentHistory.length === 0) {
      return { wethVolume: 0, usdcVolume: 0 };
    }

    const totalWethVolume = recentHistory.reduce(
      (sum, entry) => sum + entry.wethVolume,
      0,
    );
    const totalUsdcVolume = recentHistory.reduce(
      (sum, entry) => sum + entry.usdcVolume,
      0,
    );

    return {
      wethVolume: totalWethVolume / recentHistory.length,
      usdcVolume: totalUsdcVolume / recentHistory.length,
    };
  }

  /**
   * Get service status
   */
  getStatus() {
    const nextRunTime = this.getNextScheduledRunTime();
    return {
      service: 'AerodromeVolumeBlockSchedulerService',
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunDuration: this.lastRunDuration,
      nextScheduledRun: nextRunTime.toISOString(),
      schedule: 'Every 8 hours (8am, 4pm, 12am GMT+5.30)',
      description:
        'Collects volume data from subgraph and stores in 8-hour blocks',
      isInitialized: this.isInitialized,
    };
  }
}
