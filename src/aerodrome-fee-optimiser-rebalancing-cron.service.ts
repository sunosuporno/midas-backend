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
import * as cron from 'node-cron';
import { AerodromeService } from './aerodrome/aerodrome.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  AerodromePosition,
  AerodromePositionDocument,
} from './aerodrome/schemas/aerodrome-position.schema';
import { poolAbi } from './aerodrome/abis/pool';

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
  ) {}

  async onModuleInit() {
    console.log(
      '=== AERODROME FEE-OPTIMISER REBALANCING SERVICE INITIALIZED ===',
    );
    console.log(
      'Fee-optimiser rebalancing cron scheduled to run every 10 minutes',
    );
    console.log('Initial run starting immediately...');

    // Schedule fee-optimiser rebalancing cron to run every 10 minutes
    cron.schedule('*/10 * * * *', async () => {
      await this.runFeeOptimiserRebalancing();
    });

    // Start the first run immediately
    await this.runFeeOptimiserRebalancing();
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
            results.skipped++;
            console.log(
              `⏭️ Skipping position ${position.positionId} - no rebalancing needed`,
            );
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
      const tickRange3 = position.metadata?.tickRange3; // 3% range

      if (!tickRange || !tickRange3) {
        console.log(
          `Position ${position.positionId} missing tick range data - skipping`,
        );
        return false;
      }

      console.log('Tick ranges:', {
        currentTick,
        tickLower: tickRange.tickLower,
        tickUpper: tickRange.tickUpper,
        tick3Lower: tickRange3.tickLower,
        tick3Upper: tickRange3.tickUpper,
      });

      // Check if current tick is within 0.5% range (do nothing)
      const isWithin05Range =
        currentTick >= tickRange.tickLower &&
        currentTick <= tickRange.tickUpper;

      // Check if current tick is beyond 3% range (rebalance immediately)
      const isBeyond3Range =
        currentTick < tickRange3.tickLower ||
        currentTick > tickRange3.tickUpper;

      if (isWithin05Range) {
        console.log(
          `Position ${position.positionId} is within 0.5% range - no rebalancing needed`,
        );
        return false;
      }

      if (isBeyond3Range) {
        console.log(
          `Position ${position.positionId} is beyond 3% range - rebalancing immediately`,
        );
        return true;
      }

      // Current tick is between 0.5% and 3% range - check fee threshold
      console.log(
        `Position ${position.positionId} is between 0.5% and 3% range - checking fee threshold`,
      );

      const originalUsdcAmount = position.usdcAmount;
      const feeThreshold = Math.max(1, originalUsdcAmount * 0.02); // $1 or 2% of invested capital

      console.log('Fee threshold analysis:', {
        collectedFees,
        feeThreshold,
        originalUsdcAmount,
        thresholdMet: collectedFees >= feeThreshold,
      });

      if (collectedFees >= feeThreshold) {
        console.log(
          `Position ${position.positionId} meets fee threshold - rebalancing`,
        );
        return true;
      } else {
        console.log(
          `Position ${position.positionId} does not meet fee threshold - skipping`,
        );
        return false;
      }
    } catch (error) {
      console.error(
        `Error checking rebalance conditions for position ${position.positionId}:`,
        error,
      );
      return false;
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
      service: 'AerodromeFeeOptimiserRebalancingCronService',
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunDuration: this.lastRunDuration,
      schedule: 'Every 10 minutes',
      strategy: 'fee-optimiser',
    };
  }
}
