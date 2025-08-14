/**
 * Aerodrome Fee-Optimiser-V2 Rebalancing Cron Service
 *
 * This service implements a simplified fee-based rebalancing strategy:
 *
 * Strategy Logic:
 * 1. Deploy positions at specified range (e.g., 0.5%)
 * 2. Start 30-minute timer on first rebalance (regardless of position status)
 * 3. If fees earned in subsequent runs → Reset timer
 * 4. If 30 minutes elapse with no fees → Rebalance to new position at current price
 * 5. Cron runs every 10 minutes for better responsiveness
 *
 * Key Differences from V1:
 * - No complex market analysis or volume capture
 * - No rebalancing range (only original mint range matters)
 * - Simple timer-based logic with fee detection
 * - Fresh positions always at current price with optimal range
 * - Always start timer on first rebalance, reset on fees earned
 *
 * API Endpoints:
 * - POST /aerodrome/fee-optimiser-v2-rebalancing/trigger - Manual trigger
 * - GET /aerodrome/fee-optimiser-v2-rebalancing/status - Check service status
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
import { AerodromeSubgraphService } from './aerodrome/subgraph.service';

@Injectable()
export class AerodromeFeeOptimiserV2RebalancingCronService
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
    private subgraphService: AerodromeSubgraphService,
  ) {}

  async onModuleInit() {
    console.log(
      '=== AERODROME FEE-OPTIMISER-V2 REBALANCING SERVICE INITIALIZED ===',
    );
    console.log(
      'Fee-optimiser-v2 rebalancing scheduler will run every 10 minutes',
    );
    console.log('Scheduling first run in 10 minutes...');

    // Schedule fee-optimiser-v2 rebalancing to run every 10 minutes
    // Start the first run after 10 minutes instead of immediately
    setTimeout(
      () => {
        this.runFeeOptimiserV2Rebalancing();

        // Then schedule recurring runs every 10 minutes
        setInterval(
          () => {
            this.runFeeOptimiserV2Rebalancing();
          },
          10 * 60 * 1000,
        ); // 10 minutes in milliseconds
      },
      10 * 60 * 1000,
    ); // Wait 10 minutes before first run
  }

  private async runFeeOptimiserV2Rebalancing() {
    if (this.isRunning) {
      console.log(
        '⚠️ Fee-optimiser-v2 rebalancing already in progress, skipping this run',
      );
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.lastRunTime = new Date();

    try {
      console.log(
        '=== AERODROME FEE-OPTIMISER-V2 REBALANCING CRON STARTED ===',
      );
      console.log('Current time:', new Date().toISOString());

      const result = await this.processFeeOptimiserV2Positions();

      const endTime = Date.now();
      const duration = endTime - startTime;
      this.lastRunDuration = duration;

      console.log(
        '=== AERODROME FEE-OPTIMISER-V2 REBALANCING CRON COMPLETED ===',
      );
      console.log(`Duration: ${duration}ms`);
      console.log('Result:', result);
    } catch (error) {
      console.error(
        '=== AERODROME FEE-OPTIMISER-V2 REBALANCING CRON FAILED ===',
      );
      console.error('Error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  async processFeeOptimiserV2Positions(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      rebalanced: number;
      skipped: number;
      timerStarted: number;
      timerReset: number;
      errors: string[];
    };
  }> {
    try {
      console.log('=== PROCESSING FEE-OPTIMISER-V2 POSITIONS ===');
      const startTime = Date.now();

      // Get all active fee-optimiser-v2 positions
      const feeOptimiserV2Positions = await this.aerodromePositionModel.find({
        status: 'active',
        'metadata.strategyName': 'fee-optimiser-v2',
      });

      console.log(
        `Found ${feeOptimiserV2Positions.length} active fee-optimiser-v2 positions`,
      );

      const results = {
        totalPositions: feeOptimiserV2Positions.length,
        processed: 0,
        rebalanced: 0,
        skipped: 0,
        timerStarted: 0,
        timerReset: 0,
        errors: [] as string[],
      };

      for (const position of feeOptimiserV2Positions) {
        try {
          console.log(
            `Processing fee-optimiser-v2 position: ${position.positionId}`,
          );
          results.processed++;

          // Step 1: Collect fees to check if position earned any fees
          console.log(`Collecting fees for position ${position.positionId}`);
          const collectResult = await this.aerodromeService.collectFees(
            position.walletLocator,
            position.metadata?.mintDetails?.tokenId,
            false, // Calculate APR to get totalFeesUSD
          );

          const collectedFees = collectResult?.collectedFees?.totalFeesUSD || 0;
          console.log(`Fees collected: $${collectedFees}`);

          // Step 2: Check timer status and make rebalance decision
          const rebalanceDecision = await this.checkV2RebalanceCondition(
            position,
            collectedFees,
          );

          if (rebalanceDecision.action === 'rebalance') {
            console.log(
              `Rebalancing position ${position.positionId} - ${rebalanceDecision.reason}`,
            );

            const rebalanceResult =
              await this.aerodromeService.rebalancePosition(
                position.positionId,
                'fee_optimiser',
                'fee-optimiser-v2',
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
          } else if (rebalanceDecision.action === 'start_timer') {
            results.timerStarted++;
            console.log(
              `⏰ Started timer for position ${position.positionId} - first rebalance`,
            );
          } else if (rebalanceDecision.action === 'reset_timer') {
            results.timerReset++;
            console.log(
              `🔄 Reset timer for position ${position.positionId} - fees earned`,
            );
          } else {
            results.skipped++;
            console.log(
              `⏭️ Skipping position ${position.positionId} - ${rebalanceDecision.reason}`,
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

      console.log('=== FEE-OPTIMISER-V2 PROCESSING COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Fee-optimiser-v2 processing completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== FEE-OPTIMISER-V2 PROCESSING FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Fee-optimiser-v2 processing failed: ${error.message}`,
        results: {
          totalPositions: 0,
          processed: 0,
          rebalanced: 0,
          skipped: 0,
          timerStarted: 0,
          timerReset: 0,
          errors: [error.message],
        },
      };
    }
  }

  private async checkV2RebalanceCondition(
    position: any,
    collectedFees: number,
  ): Promise<{
    action: 'rebalance' | 'start_timer' | 'reset_timer' | 'skip';
    reason: string;
  }> {
    try {
      console.log(
        `=== V2 REBALANCE DECISION ANALYSIS FOR POSITION ${position.positionId} ===`,
      );

      // Step 1: Check timer status
      const timerStatus = this.getTimerStatus(position);

      // Step 2: Simplified decision logic
      if (!timerStatus.isActive) {
        // No timer active - start timer on first rebalance
        console.log(
          `⏰ Position ${position.positionId} - starting timer on first rebalance`,
        );
        await this.startTimer(position);
        return {
          action: 'start_timer',
          reason: 'Timer started on first rebalance',
        };
      } else {
        // Timer is active
        if (collectedFees > 0) {
          // Fees earned - reset timer
          console.log(
            `🔄 Position ${position.positionId} earned fees - resetting timer`,
          );
          await this.resetTimer(position);
          return {
            action: 'reset_timer',
            reason: 'Fees earned - timer reset',
          };
        } else if (timerStatus.isExpired) {
          // Timer expired with no fees - rebalance
          console.log(
            `🚨 Position ${position.positionId} timer expired - rebalancing`,
          );
          return {
            action: 'rebalance',
            reason: 'Timer expired with no fees',
          };
        } else {
          // Timer active but not expired
          const remainingMinutes = Math.ceil(
            (timerStatus.expiryTime - Date.now()) / (1000 * 60),
          );
          console.log(
            `⏳ Position ${position.positionId} timer active - ${remainingMinutes} minutes remaining`,
          );
          return {
            action: 'skip',
            reason: `Timer active - ${remainingMinutes} minutes remaining`,
          };
        }
      }
    } catch (error) {
      console.error(
        `❌ Error in V2 rebalance decision for position ${position.positionId}:`,
        error,
      );
      return {
        action: 'skip',
        reason: `Error: ${error.message}`,
      };
    }
  }

  private getTimerStatus(position: any): {
    isActive: boolean;
    isExpired: boolean;
    expiryTime: number;
    startTime: number;
  } {
    const timerData = position.metadata?.v2Timer;

    if (!timerData || !timerData.startTime) {
      return {
        isActive: false,
        isExpired: false,
        expiryTime: 0,
        startTime: 0,
      };
    }

    const startTime = new Date(timerData.startTime).getTime();
    const expiryTime = startTime + 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    const isExpired = now >= expiryTime;

    return {
      isActive: true,
      isExpired,
      expiryTime,
      startTime,
    };
  }

  private async startTimer(position: any): Promise<void> {
    const timerData = {
      startTime: new Date().toISOString(),
      expiryTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
    };

    await this.aerodromePositionModel.findByIdAndUpdate(position._id, {
      $set: {
        'metadata.v2Timer': timerData,
      },
    });

    console.log(
      `⏰ Timer started for position ${position.positionId}:`,
      timerData,
    );
  }

  private async resetTimer(position: any): Promise<void> {
    await this.aerodromePositionModel.findByIdAndUpdate(position._id, {
      $unset: {
        'metadata.v2Timer': 1,
      },
    });

    console.log(`🔄 Timer reset for position ${position.positionId}`);
  }

  async manualTriggerFeeOptimiserV2Rebalancing(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      rebalanced: number;
      skipped: number;
      timerStarted: number;
      timerReset: number;
      errors: string[];
    };
  }> {
    console.log('=== MANUAL TRIGGER: FEE-OPTIMISER-V2 REBALANCING ===');
    return await this.processFeeOptimiserV2Positions();
  }

  getStatus() {
    return {
      service: 'AerodromeFeeOptimiserV2RebalancingCronService',
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunDuration: this.lastRunDuration,
      strategy: 'fee-optimiser-v2',
      description: 'Simplified timer-based rebalancing with fee detection',
      rebalancingLogic: {
        deploymentRange: 'Configurable (e.g., 0.5%)',
        rebalancingRange: 'None (only original mint range matters)',
        timerDuration: '30 minutes',
        cronInterval: '10 minutes',
        triggerCondition: 'Timer expires with no fees earned',
        feeDetection: 'Used to reset timer when fees are earned',
        simplifiedLogic:
          'Always start timer on first rebalance, reset on fees earned',
      },
    };
  }
}
