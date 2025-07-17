/**
 * Aerodrome Rebalancing Cron Service
 *
 * This service implements dynamic scheduling for rebalancing operations:
 *
 * - Instead of fixed 2-minute intervals, the next rebalancing run starts
 *   10 minutes after the previous run completes
 *
 * - If no positions need rebalancing and the job completes in 2 minutes,
 *   the next run will be in 10 minutes (12 minutes total from last invocation)
 *
 * - If there's high volatility and many positions need rebalancing,
 *   taking 15 minutes to complete, the next run will still be 10 minutes
 *   after completion (25 minutes total from last invocation)
 *
 * - This prevents overlapping runs and ensures consistent spacing between
 *   rebalancing operations regardless of market conditions
 *
 * API Endpoints:
 * - POST /aerodrome/rebalancing/trigger - Manual trigger
 * - GET /aerodrome/rebalancing/status - Check service status
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AerodromeService } from './aerodrome/aerodrome.service';

@Injectable()
export class AerodromeRebalancingCronService implements OnModuleInit {
  private isRunning = false;
  private nextRunTimeout: NodeJS.Timeout | null = null;
  private readonly REBALANCING_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds
  private lastRunTime: Date | null = null;
  private lastRunDuration: number | null = null;
  private timeSinceLastRun: number | null = null;

  constructor(
    private configService: ConfigService,
    private aerodromeService: AerodromeService,
  ) {}

  async onModuleInit() {
    console.log('=== AERODROME REBALANCING SERVICE INITIALIZED ===');
    console.log(
      `Dynamic scheduling enabled: Next run will be 10 minutes after each completion`,
    );
    console.log(`Initial run starting immediately...`);

    // Start the first rebalancing run immediately
    this.scheduleNextRun();
  }

  private scheduleNextRun() {
    if (this.nextRunTimeout) {
      clearTimeout(this.nextRunTimeout);
    }

    const nextRunTime = new Date(Date.now() + this.REBALANCING_INTERVAL);
    console.log(
      `Scheduling next rebalancing run for: ${nextRunTime.toISOString()}`,
    );

    this.nextRunTimeout = setTimeout(async () => {
      await this.runRebalancing();
    }, this.REBALANCING_INTERVAL);
  }

  private async runRebalancing() {
    if (this.isRunning) {
      console.log('⚠️ Rebalancing already in progress, skipping this run');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.lastRunTime = new Date();

    // Calculate time since last run for dynamic search criteria
    this.timeSinceLastRun = this.lastRunTime
      ? Date.now() - this.lastRunTime.getTime()
      : this.REBALANCING_INTERVAL; // Default to interval if no previous run

    console.log(
      `Time since last rebalancing run: ${(this.timeSinceLastRun / 1000 / 60).toFixed(2)} minutes`,
    );

    try {
      console.log('=== AERODROME REBALANCING CRON STARTED ===');
      console.log('Current time:', new Date().toISOString());

      // Run the rebalancing logic with time since last run
      const result = await this.aerodromeService.runRebalancingCron(
        this.timeSinceLastRun,
      );

      const endTime = Date.now();
      const duration = endTime - startTime;
      this.lastRunDuration = duration;

      console.log('=== AERODROME REBALANCING CRON COMPLETED ===');
      console.log(
        `Duration: ${duration}ms (${(duration / 1000 / 60).toFixed(2)} minutes)`,
      );
      console.log('Result:', result);
      console.log(
        `Next rebalancing will run in ${this.REBALANCING_INTERVAL / 1000 / 60} minutes`,
      );
    } catch (error) {
      const endTime = Date.now();
      const duration = endTime - startTime;
      this.lastRunDuration = duration;

      console.error('=== AERODROME REBALANCING CRON FAILED ===');
      console.error(
        `Duration: ${duration}ms (${(duration / 1000 / 60).toFixed(2)} minutes)`,
      );
      console.error('Error:', error);
    } finally {
      this.isRunning = false;

      // Schedule the next run 10 minutes from now
      this.scheduleNextRun();
    }
  }

  /**
   * Manual trigger for testing - can be called via API endpoint
   */
  async manualTriggerRebalancing() {
    console.log('=== MANUAL REBALANCING TRIGGERED ===');
    if (this.isRunning) {
      console.log(
        '⚠️ Rebalancing already in progress, cannot trigger manually',
      );
      return {
        success: false,
        message: 'Rebalancing already in progress',
        isRunning: true,
      };
    }

    await this.runRebalancing();
    return {
      success: true,
      message: 'Manual rebalancing completed',
      isRunning: false,
    };
  }

  /**
   * Get current status of the rebalancing service
   */
  getStatus() {
    const nextRunTime = this.nextRunTimeout
      ? new Date(Date.now() + this.REBALANCING_INTERVAL)
      : null;

    return {
      isRunning: this.isRunning,
      nextRunInMinutes: this.REBALANCING_INTERVAL / 1000 / 60,
      hasNextRunScheduled: !!this.nextRunTimeout,
      nextRunTime: nextRunTime?.toISOString(),
      lastRunTime: this.lastRunTime?.toISOString(),
      lastRunDuration: this.lastRunDuration
        ? `${(this.lastRunDuration / 1000 / 60).toFixed(2)} minutes`
        : null,
      timeSinceLastRun: this.timeSinceLastRun
        ? `${(this.timeSinceLastRun / 1000 / 60).toFixed(2)} minutes`
        : null,
      serviceStatus: 'Dynamic scheduling enabled - 10 minutes after completion',
    };
  }
}
