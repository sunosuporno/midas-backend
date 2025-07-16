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
import { getPoolConfig } from './aerodrome/config/pools.config';

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

      // Find all positions with ready_for_retry status created in the past 5 minutes (matches cron frequency)
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

      const failedPositions = await this.aerodromePositionModel.find({
        status: 'ready_for_retry',
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
          const originalPercentDeviation =
            position.metadata?.tickRange?.percentDeviation !== undefined
              ? position.metadata?.tickRange?.percentDeviation
              : 1.5;

          // Calculate current USD value based on stored token amounts and current prices
          let retryUSDValue = position.usdcAmount; // fallback

          if (position.metadata?.retryMetadata?.originalTokenAmounts) {
            const storedAmounts =
              position.metadata.retryMetadata.originalTokenAmounts;
            const poolConfig = getPoolConfig(position.pool);

            if (poolConfig) {
              // Get current token prices
              let token0Price = 1; // USDC is always $1
              let token1Price = 1; // USDC is always $1

              if (
                poolConfig.token0 !==
                '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
              ) {
                // USDC address
                try {
                  token0Price = await this.aerodromeService.getTokenPrice(
                    poolConfig.token0Name,
                  );
                } catch (error) {
                  console.error(
                    `Failed to get ${poolConfig.token0Name} price:`,
                    error,
                  );
                }
              }

              if (
                poolConfig.token1 !==
                '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
              ) {
                // USDC address
                try {
                  token1Price = await this.aerodromeService.getTokenPrice(
                    poolConfig.token1Name,
                  );
                } catch (error) {
                  console.error(
                    `Failed to get ${poolConfig.token1Name} price:`,
                    error,
                  );
                }
              }

              // Calculate current USD value
              const token0Amount =
                Number(storedAmounts.token0) /
                Math.pow(10, poolConfig.token0Decimals);
              const token1Amount =
                Number(storedAmounts.token1) /
                Math.pow(10, poolConfig.token1Decimals);

              retryUSDValue =
                token0Amount * token0Price + token1Amount * token1Price;

              console.log('Calculated current USD value for retry:', {
                token0Amount,
                token0Price,
                token1Amount,
                token1Price,
                totalUSDValue: retryUSDValue,
                originalStoredValue: storedAmounts.totalUSDValue,
              });
            }
          }

          const mintParams = {
            walletLocator: position.walletLocator,
            pool: position.pool,
            usdcAmount: retryUSDValue,
            description:
              position.metadata?.description ||
              `Retry of failed position ${position.positionId}`,
            rebalancedPositionId:
              position.metadata?.rebalancedPositionId || null,
            percentDeviation: originalPercentDeviation,
            isRebalanceOrRetry: true, // Add flag for retry/rebalancing flow
            positionId: position.positionId, // Pass the position ID to get stored token amounts
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
