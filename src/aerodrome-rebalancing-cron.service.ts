import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cron from 'node-cron';
import { AerodromeService } from './aerodrome/aerodrome.service';

@Injectable()
export class AerodromeRebalancingCronService implements OnModuleInit {
  constructor(
    private configService: ConfigService,
    private aerodromeService: AerodromeService,
  ) {}

  async onModuleInit() {
    // Schedule rebalancing cron to run every 2 minutes
    cron.schedule('*/2 * * * *', async () => {
      try {
        console.log('=== AERODROME REBALANCING CRON STARTED ===');
        console.log('Current time:', new Date().toISOString());

        // Run the rebalancing logic
        const result = await this.aerodromeService.runRebalancingCron();

        console.log('=== AERODROME REBALANCING CRON COMPLETED ===');
        console.log('Result:', result);
      } catch (error) {
        console.error('=== AERODROME REBALANCING CRON FAILED ===');
        console.error('Error:', error);
      }
    });

    console.log('Aerodrome rebalancing cron scheduled to run every 2 minutes');
  }
}
