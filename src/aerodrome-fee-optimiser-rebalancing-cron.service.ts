/**
 * Aerodrome Fee-Optimiser Rebalancing Cron Service
 *
 * This service implements fee-based rebalancing for positions with strategyName: 'fee-optimiser'
 *
 * Strategy Logic:
 * 1. Collect fees for all fee-optimiser positions
 * 2. Check current tick position:
 *    - Within 0.5% range: Do nothing
 *    - Beyond 3% range: Rebalance immediately
 *    - Between 0.5-3%: Check if fees > $1 OR > 2% of invested capital, then rebalance
 *
 * API Endpoints:
 * - POST /aerodrome/fee-optimiser-rebalancing/trigger - Manual trigger
 * - GET /aerodrome/fee-optimiser-rebalancing/status - Check service status
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AerodromeService } from './aerodrome/aerodrome.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AerodromePosition,
  AerodromePositionDocument,
} from './aerodrome/schemas/aerodrome-position.schema';
import { poolAbi } from './aerodrome/abis/pool';
import { AerodromeVolumeBlockCronService } from './aerodrome-volume-block-cron.service';
import { AerodromeSubgraphService } from './aerodrome/subgraph.service';

@Injectable()
export class AerodromeFeeOptimiserRebalancingCronService
  implements OnModuleInit
{
  private isRunning = false;
  private lastRunTime: Date | null = null;
  private lastRunDuration: number | null = null;

  constructor(
    private configService: ConfigService,
    private aerodromeService: AerodromeService,
    @InjectModel(AerodromePosition.name)
    private aerodromePositionModel: Model<AerodromePositionDocument>,
    private volumeBlockService: AerodromeVolumeBlockCronService,
    private subgraphService: AerodromeSubgraphService,
  ) {}

  async onModuleInit() {
    console.log(
      '=== AERODROME FEE-OPTIMISER REBALANCING SERVICE INITIALIZED ===',
    );
    console.log(
      'Fee-optimiser rebalancing scheduler will run every 10 minutes',
    );
    console.log('Scheduling first run in 10 minutes...');

    // Schedule fee-optimiser rebalancing to run every 10 minutes
    // Start the first run after 10 minutes instead of immediately
    setTimeout(
      () => {
        this.runFeeOptimiserRebalancing();

        // Then schedule recurring runs every 10 minutes
        setInterval(
          () => {
            this.runFeeOptimiserRebalancing();
          },
          10 * 60 * 1000,
        ); // 10 minutes in milliseconds
      },
      10 * 60 * 1000,
    ); // Wait 10 minutes before first run
  }

  private async runFeeOptimiserRebalancing() {
    if (this.isRunning) {
      console.log(
        '⚠️ Fee-optimiser rebalancing already in progress, skipping this run',
      );
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.lastRunTime = new Date();

    try {
      console.log('=== AERODROME FEE-OPTIMISER REBALANCING CRON STARTED ===');
      console.log('Current time:', new Date().toISOString());

      const result = await this.processFeeOptimiserPositions();

      const endTime = Date.now();
      const duration = endTime - startTime;
      this.lastRunDuration = duration;

      console.log('=== AERODROME FEE-OPTIMISER REBALANCING CRON COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Result:', result);
    } catch (error) {
      console.error('=== AERODROME FEE-OPTIMISER REBALANCING CRON FAILED ===');
      console.error('Error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async processFeeOptimiserPositions(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      rebalanced: number;
      skipped: number;
      errors: string[];
    };
  }> {
    try {
      console.log('=== PROCESSING FEE-OPTIMISER POSITIONS ===');
      const startTime = Date.now();

      // Get all active fee-optimiser positions
      const feeOptimiserPositions = await this.aerodromePositionModel.find({
        status: 'active',
        'metadata.strategyName': 'fee-optimiser',
      });

      console.log(
        `Found ${feeOptimiserPositions.length} active fee-optimiser positions`,
      );

      const results = {
        totalPositions: feeOptimiserPositions.length,
        processed: 0,
        rebalanced: 0,
        skipped: 0,
        skippedDueToVolatility: 0,
        errors: [] as string[],
      };

      for (const position of feeOptimiserPositions) {
        try {
          console.log(
            `Processing fee-optimiser position: ${position.positionId}`,
          );
          results.processed++;

          // Step 1: Collect fees
          console.log(`Collecting fees for position ${position.positionId}`);
          // Collect fees (this returns cumulative fees, which is what we want)
          const collectResult = await this.aerodromeService.collectFees(
            position.walletLocator,
            position.metadata?.mintDetails?.tokenId,
            false, // Calculate APR to get totalFeesUSD
          );

          const collectedFees = collectResult?.collectedFees?.totalFeesUSD || 0;
          console.log(`Cumulative fees collected: $${collectedFees}`);

          // Step 2: Check current tick position
          const shouldRebalance =
            await this.checkFeeOptimiserRebalanceCondition(
              position,
              collectedFees,
            );

          if (shouldRebalance) {
            console.log(
              `Rebalancing position ${position.positionId} due to fee-optimiser conditions`,
            );

            const rebalanceResult =
              await this.aerodromeService.rebalancePosition(
                position.positionId,
                'fee_optimiser',
                'fee-optimiser',
              );

            if (rebalanceResult?.success) {
              results.rebalanced++;
              console.log(
                `✅ Successfully rebalanced position ${position.positionId}`,
              );
            } else {
              results.errors.push(
                `Failed to rebalance position ${position.positionId}`,
              );
              console.error(
                `❌ Failed to rebalance position ${position.positionId}`,
              );
            }
          } else {
            // Check if it was skipped due to volatility
            const volatilityAnalysis = position.metadata?.volatilityAnalysis;
            if (
              volatilityAnalysis &&
              volatilityAnalysis.reason === 'market_too_volatile'
            ) {
              results.skippedDueToVolatility++;
              console.log(
                `🌪️ Skipping position ${position.positionId} - market too volatile (${volatilityAnalysis.optimalRangeVolumeCapture.toFixed(2)}% volume capture)`,
              );
            } else {
              results.skipped++;
              console.log(
                `⏭️ Skipping position ${position.positionId} - no rebalancing needed`,
              );
            }
          }
        } catch (error) {
          results.errors.push(
            `Position ${position.positionId}: ${error.message}`,
          );
          console.error(
            `❌ Error processing position ${position.positionId}:`,
            error,
          );
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('=== FEE-OPTIMISER PROCESSING COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Fee-optimiser processing completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== FEE-OPTIMISER PROCESSING FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Fee-optimiser processing failed: ${error.message}`,
        results: {
          totalPositions: 0,
          processed: 0,
          rebalanced: 0,
          skipped: 0,
          errors: [error.message],
        },
      };
    }
  }

  private async checkFeeOptimiserRebalanceCondition(
    position: any,
    collectedFees: number,
  ): Promise<boolean> {
    try {
      console.log(
        `Checking rebalance conditions for position ${position.positionId}`,
      );

      // Get current tick from pool using slot0 function
      const poolAddress = position.metadata?.poolAddress;
      if (!poolAddress) {
        throw new Error(
          `Pool address not found for position ${position.positionId}`,
        );
      }

      // Call pool's slot0 function to get current tick
      const slot0Result = await this.aerodromeService['readContract'](
        poolAddress,
        poolAbi as unknown as any[],
        'slot0',
        [],
      );
      const decodedSlot0 =
        this.aerodromeService['decodeSlot0Result'](slot0Result);
      const currentTick = decodedSlot0.tick;

      console.log(`Current tick: ${currentTick}`);

      // Get tick ranges
      const tickRange = position.metadata?.tickRange; // 0.5% range
      const tickRangeRebalance = position.metadata?.tickRangeRebalance; // Configurable rebalance range
      const rebalanceRange = position.metadata?.rebalanceRange || 3.0; // Default to 3% if not stored

      if (!tickRange || !tickRangeRebalance) {
        console.log(
          `Position ${position.positionId} missing tick range data - skipping`,
        );
        return false;
      }

      console.log('Tick ranges:', {
        currentTick,
        tickLower: tickRange.tickLower,
        tickUpper: tickRange.tickUpper,
        rebalanceRange: `${rebalanceRange}%`,
        rebalanceLower: tickRangeRebalance.tickLower,
        rebalanceUpper: tickRangeRebalance.tickUpper,
      });

      // Check if current tick is within 0.5% range (do nothing)
      const isWithin05Range =
        currentTick >= tickRange.tickLower &&
        currentTick <= tickRange.tickUpper;

      // Check if current tick is beyond rebalance range (rebalance immediately)
      const isBeyondRebalanceRange =
        currentTick < tickRangeRebalance.tickLower ||
        currentTick > tickRangeRebalance.tickUpper;

      if (isWithin05Range) {
        console.log(
          `Position ${position.positionId} is within 0.5% range - no rebalancing needed`,
        );
        return false;
      }

      if (isBeyondRebalanceRange) {
        console.log(
          `Position ${position.positionId} is beyond ${rebalanceRange}% range - rebalancing immediately`,
        );
        return true;
      }

      // Current tick is between 0.5% and rebalance range - check fee threshold and fee leak detection
      console.log(
        `Position ${position.positionId} is between 0.5% and ${rebalanceRange}% range - checking fee threshold and fee leak detection`,
      );

      const originalUsdcAmount = position.usdcAmount;
      const feeThreshold = Math.max(1, originalUsdcAmount * 0.02); // $1 or 2% of invested capital

      console.log('Fee threshold analysis:', {
        collectedFees,
        feeThreshold,
        originalUsdcAmount,
        thresholdMet: collectedFees >= feeThreshold,
      });

      // Check if fees meet threshold
      if (collectedFees >= feeThreshold) {
        console.log(
          `Position ${position.positionId} meets fee threshold - rebalancing`,
        );
        return true;
      }

      // Fee leak detection: Check volume capture only when between 0.5% and 3% range
      console.log('Checking for volume capture (fee leak detection)...');
      const volumeCaptureLow = await this.checkVolumeCapture(position);

      if (volumeCaptureLow) {
        console.log(
          `Position ${position.positionId} has low volume capture - rebalancing`,
        );
        return true;
      }

      console.log(
        `Position ${position.positionId} does not meet fee threshold and has adequate volume capture - skipping`,
      );
      return false;
    } catch (error) {
      console.error(
        `Error checking rebalance conditions for position ${position.positionId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Get volume data for the last 2 hours
   */
  private async getLast2HoursVolumeData(
    tickLower?: number,
    tickUpper?: number,
  ): Promise<{
    swapsInRange: any[];
    allSwaps: any[];
    rangeVolume: { wethVolume: number; usdcVolume: number };
    totalVolume: { wethVolume: number; usdcVolume: number };
  }> {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);

    // Get all swaps in pool for last 2 hours
    const allSwaps = await this.subgraphService.getSwapsInPool(
      twoHoursAgo,
      now,
    );

    let swapsInRange = [];
    if (tickLower !== undefined && tickUpper !== undefined) {
      // Get swaps within specific tick range for last 2 hours
      swapsInRange = await this.subgraphService.getSwapsInRange(
        tickLower,
        tickUpper,
        twoHoursAgo,
        now,
      );
    }

    // Calculate volumes
    const rangeVolume = this.subgraphService.calculateVolumes(swapsInRange);
    const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

    return {
      swapsInRange,
      allSwaps,
      rangeVolume,
      totalVolume,
    };
  }

  /**
   * Check if position is capturing enough volume in its tick range
   * Only called when position is between 0.5% and 3% range
   * We want to be in range for at least 30% of the total pool volume
   */
  private async checkVolumeCapture(position: any): Promise<boolean> {
    try {
      console.log(
        `Checking volume capture for position ${position.positionId}`,
      );

      // Get position's tick range
      const tickRange = position.metadata?.tickRange;
      if (!tickRange) {
        console.log(`Position ${position.positionId} missing tick range data`);
        return false;
      }

      const tickLower = tickRange.tickLower;
      const tickUpper = tickRange.tickUpper;

      console.log(`Position tick range: ${tickLower} to ${tickUpper}`);

      // Get volume data for last 2 hours
      const volumeData = await this.getLast2HoursVolumeData(
        tickLower,
        tickUpper,
      );

      console.log(
        `Found ${volumeData.swapsInRange.length} swaps in range, ${volumeData.allSwaps.length} total swaps`,
      );

      if (volumeData.allSwaps.length === 0) {
        console.log('No swaps in the last 2 hours');
        return false;
      }

      // Calculate USD volumes
      const wethPrice = await this.aerodromeService.getTokenPrice('WETH');

      // Convert to USD
      const rangeWethUsd =
        (volumeData.rangeVolume.wethVolume / 1e18) * wethPrice; // Convert from wei
      const rangeUsdcUsd = volumeData.rangeVolume.usdcVolume / 1e6; // Convert from smallest units
      const rangeTotalUsd = rangeWethUsd + rangeUsdcUsd;

      const totalWethUsd =
        (volumeData.totalVolume.wethVolume / 1e18) * wethPrice;
      const totalUsdcUsd = volumeData.totalVolume.usdcVolume / 1e6;
      const totalPoolUsd = totalWethUsd + totalUsdcUsd;

      // Calculate percentage of volume captured
      const volumeCapturePercentage =
        totalPoolUsd > 0 ? (rangeTotalUsd / totalPoolUsd) * 100 : 0;

      console.log('Volume analysis:', {
        rangeWethVolume: volumeData.rangeVolume.wethVolume.toExponential(2),
        rangeUsdcVolume: volumeData.rangeVolume.usdcVolume.toExponential(2),
        rangeTotalUsd: `$${rangeTotalUsd.toFixed(2)}`,
        totalWethVolume: volumeData.totalVolume.wethVolume.toExponential(2),
        totalUsdcVolume: volumeData.totalVolume.usdcVolume.toExponential(2),
        totalPoolUsd: `$${totalPoolUsd.toFixed(2)}`,
        volumeCapturePercentage: `${volumeCapturePercentage.toFixed(2)}%`,
        wethPrice: `$${wethPrice}`,
      });

      // Check if we're capturing enough volume (30% threshold)
      const minVolumeCapture = 30; // 30%
      const isVolumeCaptureLow = volumeCapturePercentage < minVolumeCapture;

      console.log('Volume capture check:', {
        volumeCapturePercentage: `${volumeCapturePercentage.toFixed(2)}%`,
        minVolumeCapture: `${minVolumeCapture}%`,
        isVolumeCaptureLow,
      });

      if (isVolumeCaptureLow) {
        console.log(
          `Low volume capture detected for position ${position.positionId}:`,
          {
            volumeCapture: `${volumeCapturePercentage.toFixed(2)}%`,
            threshold: `${minVolumeCapture}%`,
          },
        );

        // Find optimal range for rebalancing
        console.log('Finding optimal tick range for rebalancing...');
        const optimalRange = await this.findOptimalTickRange(
          tickLower,
          tickUpper,
          2, // 2 hours
        );

        console.log('Optimal range analysis:', {
          originalRange: `${tickLower} to ${tickUpper}`,
          optimalRange: `${optimalRange.optimalTickLower} to ${optimalRange.optimalTickUpper}`,
          volumeCaptureImprovement: `${optimalRange.volumeCapturePercentage.toFixed(2)}%`,
          volumeInOptimalRange: `$${optimalRange.volumeInOptimalRange.toFixed(2)}`,
        });

        // Check if optimal range meets minimum volume threshold (65%)
        const minVolumeThreshold = 65; // 65% minimum volume capture
        const meetsVolumeThreshold =
          optimalRange.volumeCapturePercentage >= minVolumeThreshold;

        console.log('Volume threshold check:', {
          optimalRangeVolumeCapture: `${optimalRange.volumeCapturePercentage.toFixed(2)}%`,
          minVolumeThreshold: `${minVolumeThreshold}%`,
          meetsVolumeThreshold,
        });

        if (!meetsVolumeThreshold) {
          console.log(
            `Market too volatile for rebalancing - optimal range only captures ${optimalRange.volumeCapturePercentage.toFixed(2)}% volume (below ${minVolumeThreshold}% threshold)`,
          );

          // Store volatility analysis in position metadata
          position.metadata = position.metadata || {};
          position.metadata.volatilityAnalysis = {
            timestamp: new Date().toISOString(),
            reason: 'market_too_volatile',
            optimalRangeVolumeCapture: optimalRange.volumeCapturePercentage,
            minVolumeThreshold,
            optimalRange: {
              tickLower: optimalRange.optimalTickLower,
              tickUpper: optimalRange.optimalTickUpper,
            },
            recommendation: 'skip_rebalancing_due_to_volatility',
          };

          // Save the volatility analysis
          await this.aerodromePositionModel.findByIdAndUpdate(position._id, {
            metadata: position.metadata,
          });

          return false; // Don't rebalance during volatile periods
        }

        console.log(
          `Optimal range meets volume threshold - proceeding with rebalancing to range ${optimalRange.optimalTickLower} to ${optimalRange.optimalTickUpper}`,
        );

        // Store optimal range in position metadata for rebalancing
        // This will be used by the rebalancing service to create new position
        position.metadata = position.metadata || {};
        position.metadata.optimalRebalanceRange = {
          tickLower: optimalRange.optimalTickLower,
          tickUpper: optimalRange.optimalTickUpper,
          volumeCapturePercentage: optimalRange.volumeCapturePercentage,
          volumeInOptimalRange: optimalRange.volumeInOptimalRange,
          analysisTimestamp: new Date().toISOString(),
          meetsVolumeThreshold: true,
        };

        // Save the updated position
        await this.aerodromePositionModel.findByIdAndUpdate(position._id, {
          metadata: position.metadata,
        });

        return true;
      }

      console.log(
        `Position ${position.positionId} has adequate volume capture`,
      );
      return false;
    } catch (error) {
      console.error(
        `Error in volume capture check for position ${position.positionId}:`,
        error,
      );
      return false;
    }
  }

  /**
   * Find optimal tick range where most volume occurred in the last 2 hours
   * Returns a range with the same width as the original position
   */
  private async findOptimalTickRange(
    originalTickLower: number,
    originalTickUpper: number,
    hours: number = 2,
  ): Promise<{
    optimalTickLower: number;
    optimalTickUpper: number;
    volumeInOptimalRange: number;
    totalVolume: number;
    volumeCapturePercentage: number;
    swapsInOptimalRange: number;
    totalSwaps: number;
  }> {
    try {
      console.log(
        `Finding optimal tick range for original range ${originalTickLower} to ${originalTickUpper}`,
      );

      const rangeWidth = originalTickUpper - originalTickLower;
      console.log(`Original range width: ${rangeWidth} ticks`);

      // Get all swaps in the last 2 hours
      const hoursAgo = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const now = Math.floor(Date.now() / 1000);

      const allSwaps = await this.subgraphService.getSwapsInPool(hoursAgo, now);
      console.log(`Analyzing ${allSwaps.length} swaps for optimal range`);

      if (allSwaps.length === 0) {
        throw new Error('No swaps found in the specified time period');
      }

      // Get tick spacing from pool config (assuming WETH-USDC pool)
      const tickSpacing = 100; // WETH-USDC pool tick spacing

      // Find min and max ticks from all swaps
      const allTicks = allSwaps.map((swap) => swap.tick).sort((a, b) => a - b);
      const minTick = allTicks[0];
      const maxTick = allTicks[allTicks.length - 1];

      console.log(`Tick range in data: ${minTick} to ${maxTick}`);

      // Calculate possible range boundaries (must be divisible by tick spacing)
      const startTick = Math.floor(minTick / tickSpacing) * tickSpacing;
      const endTick = Math.ceil(maxTick / tickSpacing) * tickSpacing;

      console.log(`Adjusted range boundaries: ${startTick} to ${endTick}`);

      let optimalTickLower = startTick;
      let optimalTickUpper = startTick + rangeWidth;
      let maxVolume = 0;

      // Slide the range window across all possible positions
      for (
        let currentLower = startTick;
        currentLower <= endTick - rangeWidth;
        currentLower += tickSpacing
      ) {
        const currentUpper = currentLower + rangeWidth;

        // Get swaps in this range
        const swapsInRange = allSwaps.filter(
          (swap) => swap.tick >= currentLower && swap.tick <= currentUpper,
        );

        if (swapsInRange.length === 0) continue;

        // Calculate volume in this range
        const rangeVolume = this.subgraphService.calculateVolumes(swapsInRange);
        const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

        // Get WETH price for USD conversion
        const wethPrice = await this.aerodromeService.getTokenPrice('WETH');

        // Convert to USD
        const rangeWethUsd = (rangeVolume.wethVolume / 1e18) * wethPrice;
        const rangeUsdcUsd = rangeVolume.usdcVolume / 1e6;
        const rangeTotalUsd = rangeWethUsd + rangeUsdcUsd;

        const totalWethUsd = (totalVolume.wethVolume / 1e18) * wethPrice;
        const totalUsdcUsd = totalVolume.usdcVolume / 1e6;
        const totalPoolUsd = totalWethUsd + totalUsdcUsd;

        // Calculate volume capture percentage
        const volumeCapturePercentage =
          totalPoolUsd > 0 ? (rangeTotalUsd / totalPoolUsd) * 100 : 0;

        console.log(
          `Range ${currentLower} to ${currentUpper}: ${volumeCapturePercentage.toFixed(2)}% capture, $${rangeTotalUsd.toFixed(2)} volume`,
        );

        // Update optimal range if this has higher volume
        if (rangeTotalUsd > maxVolume) {
          maxVolume = rangeTotalUsd;
          optimalTickLower = currentLower;
          optimalTickUpper = currentUpper;
        }
      }

      // Get final statistics for optimal range
      const optimalSwaps = allSwaps.filter(
        (swap) =>
          swap.tick >= optimalTickLower && swap.tick <= optimalTickUpper,
      );
      const optimalRangeVolume =
        this.subgraphService.calculateVolumes(optimalSwaps);
      const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

      const wethPrice = await this.aerodromeService.getTokenPrice('WETH');
      const optimalWethUsd = (optimalRangeVolume.wethVolume / 1e18) * wethPrice;
      const optimalUsdcUsd = optimalRangeVolume.usdcVolume / 1e6;
      const optimalTotalUsd = optimalWethUsd + optimalUsdcUsd;

      const totalWethUsd = (totalVolume.wethVolume / 1e18) * wethPrice;
      const totalUsdcUsd = totalVolume.usdcVolume / 1e6;
      const totalPoolUsd = totalWethUsd + totalUsdcUsd;

      const finalVolumeCapturePercentage =
        totalPoolUsd > 0 ? (optimalTotalUsd / totalPoolUsd) * 100 : 0;

      console.log('=== OPTIMAL RANGE ANALYSIS COMPLETE ===');
      console.log(
        `Original range: ${originalTickLower} to ${originalTickUpper}`,
      );
      console.log(`Optimal range: ${optimalTickLower} to ${optimalTickUpper}`);
      console.log(
        `Volume capture improvement: ${finalVolumeCapturePercentage.toFixed(2)}%`,
      );
      console.log(`Volume in optimal range: $${optimalTotalUsd.toFixed(2)}`);

      return {
        optimalTickLower,
        optimalTickUpper,
        volumeInOptimalRange: optimalTotalUsd,
        totalVolume: totalPoolUsd,
        volumeCapturePercentage: finalVolumeCapturePercentage,
        swapsInOptimalRange: optimalSwaps.length,
        totalSwaps: allSwaps.length,
      };
    } catch (error) {
      console.error('Error finding optimal tick range:', error);
      throw error;
    }
  }

  /**
   * Manual trigger for testing - can be called via API endpoint
   */
  async manualTriggerFeeOptimiserRebalancing(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      rebalanced: number;
      skipped: number;
      errors: string[];
    };
  }> {
    console.log('=== MANUAL FEE-OPTIMISER REBALANCING TRIGGERED ===');
    return await this.processFeeOptimiserPositions();
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      service: 'AerodromeFeeOptimiserRebalancingSchedulerService',
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunDuration: this.lastRunDuration,
      schedule: 'Every 10 minutes',
      strategy: 'fee-optimiser',
      nextRunEstimate: this.lastRunTime
        ? new Date(this.lastRunTime.getTime() + 10 * 60 * 1000).toISOString()
        : 'First run in 10 minutes',
    };
  }

  /**
   * Test volume capture for a specific position
   */
  async testVolumeCaptureForPosition(
    positionId: string,
    hours: number = 2,
  ): Promise<any> {
    try {
      console.log(`=== TESTING VOLUME CAPTURE FOR POSITION ${positionId} ===`);

      const position = await this.aerodromePositionModel.findOne({
        positionId: positionId,
      });

      if (!position) {
        throw new Error(`Position ${positionId} not found`);
      }

      console.log('Position found:', {
        positionId: position.positionId,
        tickRange: position.metadata?.tickRange,
        strategyName: position.metadata?.strategyName,
      });

      const tickRange = position.metadata?.tickRange;
      if (!tickRange) {
        throw new Error(`Position ${positionId} missing tick range data`);
      }

      const result = await this.testVolumeCaptureForRange(
        tickRange.tickLower,
        tickRange.tickUpper,
        hours,
      );

      return {
        positionId,
        position: {
          tickRange: position.metadata?.tickRange,
          strategyName: position.metadata?.strategyName,
          usdcAmount: position.usdcAmount,
        },
        ...result,
      };
    } catch (error) {
      console.error(
        `Error testing volume capture for position ${positionId}:`,
        error,
      );
      return {
        error: error.message,
        positionId,
      };
    }
  }

  /**
   * Test volume capture for a specific tick range
   */
  async testVolumeCaptureForRange(
    tickLower: number,
    tickUpper: number,
    hours: number = 2,
  ): Promise<any> {
    try {
      console.log(
        `=== TESTING VOLUME CAPTURE FOR RANGE ${tickLower} to ${tickUpper} ===`,
      );
      console.log(`Time period: Last ${hours} hours`);

      const hoursAgo = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const now = Math.floor(Date.now() / 1000);

      console.log(
        `Fetching swaps from ${new Date(hoursAgo * 1000).toISOString()} to ${new Date(now * 1000).toISOString()}`,
      );

      // Get all swaps in pool for the specified hours
      const allSwaps = await this.subgraphService.getSwapsInPool(hoursAgo, now);
      console.log(`Found ${allSwaps.length} total swaps in pool`);

      // Get swaps within specific tick range
      const swapsInRange = await this.subgraphService.getSwapsInRange(
        tickLower,
        tickUpper,
        hoursAgo,
        now,
      );
      console.log(
        `Found ${swapsInRange.length} swaps in range ${tickLower} to ${tickUpper}`,
      );

      // Calculate volumes
      const rangeVolume = this.subgraphService.calculateVolumes(swapsInRange);
      const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

      // Get WETH price for USD conversion
      const wethPrice = await this.aerodromeService.getTokenPrice('WETH');
      console.log(`Current WETH price: $${wethPrice}`);

      // Convert to USD
      const rangeWethUsd = (rangeVolume.wethVolume / 1e18) * wethPrice;
      const rangeUsdcUsd = rangeVolume.usdcVolume / 1e6;
      const rangeTotalUsd = rangeWethUsd + rangeUsdcUsd;

      const totalWethUsd = (totalVolume.wethVolume / 1e18) * wethPrice;
      const totalUsdcUsd = totalVolume.usdcVolume / 1e6;
      const totalPoolUsd = totalWethUsd + totalUsdcUsd;

      // Calculate percentage of volume captured
      const volumeCapturePercentage =
        totalPoolUsd > 0 ? (rangeTotalUsd / totalPoolUsd) * 100 : 0;

      // Check if we're capturing enough volume (30% threshold)
      const minVolumeCapture = 30;
      const isVolumeCaptureLow = volumeCapturePercentage < minVolumeCapture;

      const result = {
        tickRange: { tickLower, tickUpper },
        timePeriod: `${hours} hours`,
        volumeData: {
          swapsInRange: swapsInRange.length,
          totalSwaps: allSwaps.length,
          rangeVolume: {
            wethVolume: rangeVolume.wethVolume.toExponential(2),
            usdcVolume: rangeVolume.usdcVolume.toExponential(2),
            wethUsd: `$${rangeWethUsd.toFixed(2)}`,
            usdcUsd: `$${rangeUsdcUsd.toFixed(2)}`,
            totalUsd: `$${rangeTotalUsd.toFixed(2)}`,
          },
          totalVolume: {
            wethVolume: totalVolume.wethVolume.toExponential(2),
            usdcVolume: totalVolume.usdcVolume.toExponential(2),
            wethUsd: `$${totalWethUsd.toFixed(2)}`,
            usdcUsd: `$${totalUsdcUsd.toFixed(2)}`,
            totalUsd: `$${totalPoolUsd.toFixed(2)}`,
          },
          volumeCapturePercentage: `${volumeCapturePercentage.toFixed(2)}%`,
          minVolumeCapture: `${minVolumeCapture}%`,
          isVolumeCaptureLow,
          wethPrice: `$${wethPrice}`,
        },
        analysis: {
          recommendation: isVolumeCaptureLow
            ? 'LOW VOLUME CAPTURE - Consider rebalancing'
            : 'ADEQUATE VOLUME CAPTURE - Position is capturing sufficient volume',
          threshold: `${minVolumeCapture}%`,
          currentCapture: `${volumeCapturePercentage.toFixed(2)}%`,
        },
      };

      console.log('=== VOLUME CAPTURE TEST RESULTS ===');
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      console.error('Error testing volume capture for range:', error);
      return {
        error: error.message,
        tickRange: { tickLower, tickUpper },
        timePeriod: `${hours} hours`,
      };
    }
  }

  /**
   * Test optimal range detection for a given range width
   */
  async testOptimalRangeDetection(
    rangeWidth: number,
    hours: number = 2,
    testVolatilityThreshold: boolean = false,
  ): Promise<any> {
    try {
      console.log(`=== TESTING OPTIMAL RANGE DETECTION ===`);
      console.log(`Range width: ${rangeWidth} ticks`);
      console.log(`Time period: Last ${hours} hours`);

      // Get all swaps in the last 2 hours
      const hoursAgo = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const now = Math.floor(Date.now() / 1000);

      const allSwaps = await this.subgraphService.getSwapsInPool(hoursAgo, now);
      console.log(`Found ${allSwaps.length} total swaps in pool`);

      if (allSwaps.length === 0) {
        return {
          error: 'No swaps found in the specified time period',
          rangeWidth,
          timePeriod: `${hours} hours`,
        };
      }

      // Get tick spacing from pool config (assuming WETH-USDC pool)
      const tickSpacing = 100;

      // Find min and max ticks from all swaps
      const allTicks = allSwaps.map((swap) => swap.tick).sort((a, b) => a - b);
      const minTick = allTicks[0];
      const maxTick = allTicks[allTicks.length - 1];

      // Calculate possible range boundaries (must be divisible by tick spacing)
      const startTick = Math.floor(minTick / tickSpacing) * tickSpacing;
      const endTick = Math.ceil(maxTick / tickSpacing) * tickSpacing;

      let optimalTickLower = startTick;
      let optimalTickUpper = startTick + rangeWidth;
      let maxVolume = 0;
      const allRanges: Array<{
        tickLower: number;
        tickUpper: number;
        volumeCapturePercentage: number;
        volumeUsd: number;
        swapsCount: number;
      }> = [];

      // Slide the range window across all possible positions
      for (
        let currentLower = startTick;
        currentLower <= endTick - rangeWidth;
        currentLower += tickSpacing
      ) {
        const currentUpper = currentLower + rangeWidth;

        // Get swaps in this range
        const swapsInRange = allSwaps.filter(
          (swap) => swap.tick >= currentLower && swap.tick <= currentUpper,
        );

        if (swapsInRange.length === 0) continue;

        // Calculate volume in this range
        const rangeVolume = this.subgraphService.calculateVolumes(swapsInRange);
        const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

        // Get WETH price for USD conversion
        const wethPrice = await this.aerodromeService.getTokenPrice('WETH');

        // Convert to USD
        const rangeWethUsd = (rangeVolume.wethVolume / 1e18) * wethPrice;
        const rangeUsdcUsd = rangeVolume.usdcVolume / 1e6;
        const rangeTotalUsd = rangeWethUsd + rangeUsdcUsd;

        const totalWethUsd = (totalVolume.wethVolume / 1e18) * wethPrice;
        const totalUsdcUsd = totalVolume.usdcVolume / 1e6;
        const totalPoolUsd = totalWethUsd + totalUsdcUsd;

        // Calculate volume capture percentage
        const volumeCapturePercentage =
          totalPoolUsd > 0 ? (rangeTotalUsd / totalPoolUsd) * 100 : 0;

        allRanges.push({
          tickLower: currentLower,
          tickUpper: currentUpper,
          volumeCapturePercentage,
          volumeUsd: rangeTotalUsd,
          swapsCount: swapsInRange.length,
        });

        // Update optimal range if this has higher volume
        if (rangeTotalUsd > maxVolume) {
          maxVolume = rangeTotalUsd;
          optimalTickLower = currentLower;
          optimalTickUpper = currentUpper;
        }
      }

      // Sort ranges by volume capture percentage (descending)
      allRanges.sort(
        (a, b) => b.volumeCapturePercentage - a.volumeCapturePercentage,
      );

      // Get top 10 ranges
      const topRanges = allRanges.slice(0, 10);

      const optimalRangeData = allRanges.find(
        (r) =>
          r.tickLower === optimalTickLower && r.tickUpper === optimalTickUpper,
      );

      const result = {
        rangeWidth,
        timePeriod: `${hours} hours`,
        totalSwaps: allSwaps.length,
        tickRange: { minTick, maxTick },
        optimalRange: {
          tickLower: optimalTickLower,
          tickUpper: optimalTickUpper,
          volumeCapturePercentage:
            optimalRangeData?.volumeCapturePercentage || 0,
          volumeUsd: maxVolume,
          swapsCount: optimalRangeData?.swapsCount || 0,
        },
        topRanges,
        wethPrice: `$${await this.aerodromeService.getTokenPrice('WETH')}`,
        ...(testVolatilityThreshold && {
          volatilityAnalysis: {
            volumeCapturePercentage: `${optimalRangeData?.volumeCapturePercentage.toFixed(2) || '0'}%`,
            minVolumeThreshold: '65%',
            meetsVolumeThreshold:
              (optimalRangeData?.volumeCapturePercentage || 0) >= 65,
            recommendation:
              (optimalRangeData?.volumeCapturePercentage || 0) >= 65
                ? 'PROCEED_WITH_REBALANCING'
                : 'SKIP_REBALANCING_DUE_TO_VOLATILITY',
            explanation:
              (optimalRangeData?.volumeCapturePercentage || 0) >= 65
                ? `Optimal range captures ${optimalRangeData?.volumeCapturePercentage.toFixed(2)}% volume - meets 65% threshold for safe rebalancing`
                : `Optimal range captures ${optimalRangeData?.volumeCapturePercentage.toFixed(2)}% volume - below 65% threshold, market too volatile for rebalancing`,
          },
        }),
        timestamp: new Date().toISOString(),
      };

      console.log('=== OPTIMAL RANGE DETECTION TEST RESULTS ===');
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      console.error('Error testing optimal range detection:', error);
      return {
        error: error.message,
        rangeWidth,
        timePeriod: `${hours} hours`,
      };
    }
  }

  /**
   * Test current pool volume capture (no specific range)
   */
  async testCurrentPoolVolumeCapture(hours: number = 2): Promise<any> {
    try {
      console.log(`=== TESTING CURRENT POOL VOLUME CAPTURE ===`);
      console.log(`Time period: Last ${hours} hours`);

      const hoursAgo = Math.floor(Date.now() / 1000) - hours * 60 * 60;
      const now = Math.floor(Date.now() / 1000);

      // Get all swaps in pool for the specified hours
      const allSwaps = await this.subgraphService.getSwapsInPool(hoursAgo, now);
      console.log(`Found ${allSwaps.length} total swaps in pool`);

      // Calculate total volume
      const totalVolume = this.subgraphService.calculateVolumes(allSwaps);

      // Get WETH price for USD conversion
      const wethPrice = await this.aerodromeService.getTokenPrice('WETH');

      // Convert to USD
      const totalWethUsd = (totalVolume.wethVolume / 1e18) * wethPrice;
      const totalUsdcUsd = totalVolume.usdcVolume / 1e6;
      const totalPoolUsd = totalWethUsd + totalUsdcUsd;

      const result = {
        timePeriod: `${hours} hours`,
        poolVolume: {
          totalSwaps: allSwaps.length,
          wethVolume: totalVolume.wethVolume.toExponential(2),
          usdcVolume: totalVolume.usdcVolume.toExponential(2),
          wethUsd: `$${totalWethUsd.toFixed(2)}`,
          usdcUsd: `$${totalUsdcUsd.toFixed(2)}`,
          totalUsd: `$${totalPoolUsd.toFixed(2)}`,
        },
        wethPrice: `$${wethPrice}`,
        timestamp: new Date().toISOString(),
      };

      console.log('=== POOL VOLUME TEST RESULTS ===');
      console.log(JSON.stringify(result, null, 2));

      return result;
    } catch (error) {
      console.error('Error testing current pool volume capture:', error);
      return {
        error: error.message,
        timePeriod: `${hours} hours`,
      };
    }
  }
}
