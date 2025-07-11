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
export class AerodromeRetryFailedMintsCronService implements OnModuleInit {
  constructor(
    private configService: ConfigService,
    private aerodromeService: AerodromeService,
    @InjectModel(AerodromePosition.name)
    private aerodromePositionModel: Model<AerodromePositionDocument>,
  ) {}

  async onModuleInit() {
    // Schedule retry cron to run every 5 minutes (reduced from 15 minutes for better efficiency)
    cron.schedule('*/5 * * * *', async () => {
      try {
        console.log('=== AERODROME RETRY FAILED MINTS CRON STARTED ===');
        console.log('Current time:', new Date().toISOString());

        // Run the retry logic
        const result = await this.retryFailedMints();

        console.log('=== AERODROME RETRY FAILED MINTS CRON COMPLETED ===');
        console.log('Result:', result);
      } catch (error) {
        console.error('=== AERODROME RETRY FAILED MINTS CRON FAILED ===');
        console.error('Error:', error);
      }
    });

    console.log(
      'Aerodrome retry failed mints cron scheduled to run every 5 minutes',
    );
  }

  async retryFailedMints(): Promise<{
    success: boolean;
    message: string;
    results: {
      found: number;
      processed: number;
      successful: number;
      failed: number;
      skipped: number;
    };
  }> {
    try {
      console.log('=== STARTING RETRY FAILED MINTS ===');
      const startTime = Date.now();

      // Find all positions with cleaned_up status created in the past 5 minutes (matches cron frequency)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const failedPositions = await this.aerodromePositionModel.find({
        status: 'cleaned_up',
        createdAt: { $gte: fiveMinutesAgo },
      });

      console.log(`Found ${failedPositions.length} failed positions to retry`);

      const results = {
        found: failedPositions.length,
        processed: 0,
        successful: 0,
        failed: 0,
        skipped: 0,
      };

      for (const position of failedPositions) {
        try {
          console.log(`Processing failed position: ${position.positionId}`);
          results.processed++;

          // Prepare mint parameters from the original position data
          const mintParams = {
            walletLocator: position.walletLocator,
            pool: position.pool,
            usdcAmount: position.usdcAmount,
            description:
              position.metadata?.description ||
              `Retry of failed position ${position.positionId}`,
            rebalancedPositionId:
              position.metadata?.rebalancedPositionId || null,
            percentDeviation:
              position.metadata?.tickRange?.percentDeviation || 0,
          };

          console.log('Retry mint params:', mintParams);

          // Attempt to mint the position again
          const mintResult = await this.aerodromeService.mint(mintParams);

          if (mintResult && mintResult.status === 'active') {
            results.successful++;
            console.log(
              `✅ Successfully retried mint for position ${position.positionId}`,
            );

            // If this was a rebalanced position, update the original position status
            if (position.metadata?.rebalancedPositionId) {
              const originalPositionId = position.metadata.rebalancedPositionId;
              console.log(
                `Updating original position ${originalPositionId} status to rebalanced`,
              );

              await this.aerodromePositionModel.findOneAndUpdate(
                { positionId: originalPositionId },
                {
                  status: 'rebalanced',
                  $set: {
                    'metadata.retrySuccess': {
                      timestamp: new Date().toISOString(),
                      newPositionId: mintResult.positionId,
                      retryPositionId: position.positionId,
                    },
                  },
                },
              );
            }

            // Update the retry position status to indicate it was successfully retried
            await this.aerodromePositionModel.findOneAndUpdate(
              { positionId: position.positionId },
              {
                status: 'retry_successful',
                $set: {
                  'metadata.retryResult': {
                    timestamp: new Date().toISOString(),
                    newPositionId: mintResult.positionId,
                    success: true,
                  },
                },
              },
            );
          } else {
            results.failed++;
            console.log(
              `❌ Failed to retry mint for position ${position.positionId}:`,
              mintResult,
            );

            // Update the retry position with failure info
            await this.aerodromePositionModel.findOneAndUpdate(
              { positionId: position.positionId },
              {
                status: 'retry_failed',
                $set: {
                  'metadata.retryResult': {
                    timestamp: new Date().toISOString(),
                    success: false,
                    error: mintResult?.message || 'Unknown error',
                  },
                },
              },
            );
          }
        } catch (error) {
          results.failed++;
          console.error(
            `❌ Error processing failed position ${position.positionId}:`,
            error,
          );

          // Update the retry position with error info
          await this.aerodromePositionModel.findOneAndUpdate(
            { positionId: position.positionId },
            {
              status: 'retry_failed',
              $set: {
                'metadata.retryResult': {
                  timestamp: new Date().toISOString(),
                  success: false,
                  error: error.message,
                },
              },
            },
          );
        }
      }

      const endTime = Date.now();
      const duration = endTime - startTime;

      console.log('=== RETRY FAILED MINTS COMPLETED ===');
      console.log(`Duration: ${duration}ms`);
      console.log('Results:', results);

      return {
        success: true,
        message: `Retry failed mints completed successfully in ${duration}ms`,
        results,
      };
    } catch (error) {
      console.error('=== RETRY FAILED MINTS FAILED ===');
      console.error('Error:', error);

      return {
        success: false,
        message: `Retry failed mints failed: ${error.message}`,
        results: {
          found: 0,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: 0,
        },
      };
    }
  }
}
