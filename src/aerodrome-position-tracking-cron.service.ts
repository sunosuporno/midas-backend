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

@Injectable()
export class AerodromePositionTrackingCronService implements OnModuleInit {
  constructor(
    private configService: ConfigService,
    private aerodromeService: AerodromeService,
    @InjectModel(AerodromePosition.name)
    private aerodromePositionModel: Model<AerodromePositionDocument>,
  ) {}

  async onModuleInit() {
    // Schedule position tracking cron to run every 40 minutes
    cron.schedule('*/40 * * * *', async () => {
      try {
        console.log('=== AERODROME POSITION TRACKING CRON STARTED ===');
        console.log('Current time:', new Date().toISOString());

        // Run the position tracking logic
        const result = await this.trackAllActivePositions();

        console.log('=== AERODROME POSITION TRACKING CRON COMPLETED ===');
        console.log('Result:', result);
      } catch (error) {
        console.error('=== AERODROME POSITION TRACKING CRON FAILED ===');
        console.error('Error:', error);
      }
    });

    console.log(
      'Aerodrome position tracking cron scheduled to run every 40 minutes',
    );
  }

  async trackAllActivePositions(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      successful: number;
      failed: number;
      skipped: number;
      errors: string[];
    };
  }> {
    try {
      console.log('=== STARTING POSITION TRACKING ===');
      const startTime = Date.now();

      // Find all active positions
      const activePositions = await this.aerodromePositionModel.find({
        status: 'active',
      });

      console.log(`Found ${activePositions.length} active positions to track`);

      const results = {
        totalPositions: activePositions.length,
        processed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
        errors: [] as string[],
      };

      for (const position of activePositions) {
        try {
          console.log(`Processing position: ${position.positionId}`);
          results.processed++;

          // Call getPositionDetails which will automatically save the tracking data
          const positionDetails =
            await this.aerodromeService.getPositionDetails(position.positionId);

          if (positionDetails) {
            results.successful++;
            console.log(
              `✅ Successfully tracked position ${position.positionId}`,
            );
          } else {
            results.failed++;
            console.log(
              `❌ Failed to track position ${position.positionId}: No details returned`,
            );
            results.errors.push(
              `Position ${position.positionId}: No details returned`,
            );
          }
        } catch (error) {
          results.failed++;
          const errorMessage = `Position ${position.positionId}: ${error.message}`;
          console.error(
            `❌ Error processing position ${position.positionId}:`,
            error,
          );
          results.errors.push(errorMessage);
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('=== POSITION TRACKING COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Position tracking completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== POSITION TRACKING FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Position tracking failed: ${error.message}`,
        results: {
          totalPositions: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
          errors: [error.message],
        },
      };
    }
  }

  /**
   * Manual trigger for testing - can be called via API endpoint
   */
  async manualTrackAllPositions(): Promise<{
    success: boolean;
    message: string;
    results: {
      totalPositions: number;
      processed: number;
      successful: number;
      failed: number;
      skipped: number;
      errors: string[];
    };
  }> {
    console.log('=== MANUAL POSITION TRACKING TRIGGERED ===');
    return await this.trackAllActivePositions();
  }
}
