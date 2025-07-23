import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { AerodromeService } from './aerodrome.service';
import { CreateAerodromeLpDto } from './dto/create-aerodrome-lp.dto';
import { Public } from '../decorators/public.decorator';
import { AerodromePositionTrackingCronService } from '../aerodrome-position-tracking-cron.service';
import { AerodromeRebalancingCronService } from '../aerodrome-rebalancing-cron.service';
import { AerodromeFeeOptimiserRebalancingCronService } from '../aerodrome-fee-optimiser-rebalancing-cron.service';
import { AerodromeVolumeBlockCronService } from '../aerodrome-volume-block-cron.service';

@Controller('aerodrome')
export class AerodromeController {
  constructor(
    private readonly aerodromeService: AerodromeService,
    private readonly positionTrackingCronService: AerodromePositionTrackingCronService,
    private readonly rebalancingCronService: AerodromeRebalancingCronService,
    private readonly feeOptimiserRebalancingCronService: AerodromeFeeOptimiserRebalancingCronService,
    private readonly volumeBlockCronService: AerodromeVolumeBlockCronService,
  ) {}

  @Public()
  @Post('mint')
  @HttpCode(HttpStatus.CREATED)
  async mint(@Body() createAerodromeLpDto: CreateAerodromeLpDto) {
    return this.aerodromeService.mint(createAerodromeLpDto);
  }

  @Public()
  @Get('position/:positionId')
  async getPosition(@Param('positionId') positionId: string) {
    return this.aerodromeService.getPosition(positionId);
  }

  @Public()
  @Get('positions/:walletLocator')
  async getPositionsByWallet(@Param('walletLocator') walletLocator: string) {
    return this.aerodromeService.getPositionsByWallet(walletLocator);
  }

  @Public()
  @Get('pools')
  async getAvailablePools() {
    return this.aerodromeService.getAvailablePools();
  }

  @Public()
  @Get('quote')
  async getSwapQuote(
    @Query('walletLocator') walletLocator: string,
    @Query('pool') pool: string,
    @Query('usdcAmount') usdcAmount: string,
  ) {
    const amount = parseFloat(usdcAmount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Invalid USDC amount');
    }

    return this.aerodromeService.getSwapQuote(
      walletLocator,
      pool,
      amount,
      30, // Fixed slippage of 0.3%
    );
  }

  @Public()
  @Post('burn')
  async burn(@Body() body: { walletLocator: string; tokenId: string }) {
    const { walletLocator, tokenId } = body;
    return this.aerodromeService.burn(walletLocator, tokenId);
  }

  @Public()
  @Post('collect-fees')
  async collectFees(@Body() body: { walletLocator: string; tokenId: string }) {
    const { walletLocator, tokenId } = body;
    return this.aerodromeService.collectFees(walletLocator, tokenId);
  }

  @Public()
  @Get('test/out-of-range')
  async getOutOfRangePositions(@Query('tick') tick: string) {
    const parsedTick = Number(tick);
    if (isNaN(parsedTick)) {
      throw new Error('Invalid tick value');
    }
    return this.aerodromeService.findActivePositionsOutOfRange(parsedTick);
  }

  @Public()
  @Get('test/older-than-5h')
  async getOlderThan5hPositions() {
    return this.aerodromeService.findActivePositionsOlderThan5h();
  }

  @Public()
  @Post('cleanup-failed-mint')
  async cleanupFailedMint(
    @Body()
    body: {
      positionId: string;
      actualToken0Amount?: string;
      actualToken1Amount?: string;
    },
  ) {
    const { positionId, actualToken0Amount, actualToken1Amount } = body;
    return this.aerodromeService.cleanupFailedMint(
      positionId,
      actualToken0Amount || '0',
      actualToken1Amount || '0',
    );
  }

  @Public()
  @Post('retry-failed-mints')
  async retryFailedMints() {
    // This will trigger the retry logic manually for testing
    // Note: Immediate retries are now handled in the main mint function
    return this.aerodromeService.retryFailedMints();
  }

  @Public()
  @Post('test-1inch')
  async test1inchIntegration(
    @Body()
    body: {
      walletLocator: string;
      sellToken: string;
      buyToken: string;
      amount: string;
    },
  ) {
    const { walletLocator, sellToken, buyToken, amount } = body;
    return this.aerodromeService.test1inchIntegration(
      walletLocator,
      sellToken,
      buyToken,
      amount,
    );
  }

  @Public()
  @Post('rebalance')
  async rebalancePosition(
    @Body()
    body: {
      positionId: string;
      reason: 'out_of_range' | 'dollar_fees' | 'imbalanced' | 'age_limit';
      strategyName?: string;
    },
  ) {
    const { positionId, reason, strategyName } = body;
    return this.aerodromeService.rebalancePosition(
      positionId,
      reason,
      strategyName,
    );
  }

  @Public()
  @Get('position/:positionId/details')
  async getPositionDetails(@Param('positionId') positionId: string) {
    return this.aerodromeService.getPositionDetails(positionId);
  }

  @Public()
  @Post('track-all-positions')
  async trackAllPositions() {
    return this.positionTrackingCronService.manualTrackAllPositions();
  }

  @Public()
  @Get('queue-status/:walletLocator')
  async getWalletQueueStatus(@Param('walletLocator') walletLocator: string) {
    return this.aerodromeService.getWalletQueueStatus(walletLocator);
  }

  @Public()
  @Post('clear-rebalancing-state/:walletLocator')
  async clearRebalancingState(@Param('walletLocator') walletLocator: string) {
    return this.aerodromeService.clearWalletRebalancingState(walletLocator);
  }

  @Public()
  @Post('rebalancing/trigger')
  async triggerRebalancing() {
    return this.rebalancingCronService.manualTriggerRebalancing();
  }

  @Public()
  @Get('rebalancing/status')
  async getRebalancingStatus() {
    return this.rebalancingCronService.getStatus();
  }

  @Public()
  @Post('delete-junk-positions')
  async deleteJunkPositions() {
    return this.aerodromeService.deleteJunkPositions();
  }

  @Public()
  @Post('fee-optimiser-rebalancing/trigger')
  async triggerFeeOptimiserRebalancing() {
    return this.feeOptimiserRebalancingCronService.manualTriggerFeeOptimiserRebalancing();
  }

  @Public()
  @Get('fee-optimiser-rebalancing/status')
  async getFeeOptimiserRebalancingStatus() {
    return this.feeOptimiserRebalancingCronService.getStatus();
  }

  @Public()
  @Post('volume-blocks/trigger')
  async triggerVolumeBlockCollection() {
    return this.volumeBlockCronService.manualTriggerVolumeBlockCollection();
  }

  @Public()
  @Get('volume-blocks/status')
  async getVolumeBlockStatus() {
    return this.volumeBlockCronService.getStatus();
  }

  @Public()
  @Get('volume-blocks')
  async getVolumeBlockData() {
    return this.volumeBlockCronService.getVolumeBlockData();
  }

  @Public()
  @Post('volume-blocks/clear')
  async clearVolumeBlockData() {
    return this.volumeBlockCronService.clearVolumeBlockData();
  }

  @Public()
  @Get('volume-blocks/average/:period')
  async getAverageVolumeForPeriod(
    @Param('period') period: 'morning' | 'afternoon' | 'night',
    @Query('days') days: string = '7',
  ) {
    const daysNum = parseInt(days, 10);
    return {
      poolAddress: 'weth-usdc',
      period,
      days: daysNum,
      averageVolumes:
        await this.volumeBlockCronService.getAverageVolumesForPeriod(
          period,
          daysNum,
        ),
    };
  }

  @Public()
  @Get('test/fee-leak-detection')
  async testFeeLeakDetection(
    @Query('positionId') positionId?: string,
    @Query('tickLower') tickLower?: string,
    @Query('tickUpper') tickUpper?: string,
    @Query('hours') hours: string = '2',
  ) {
    const hoursCount = parseInt(hours, 10);

    if (positionId) {
      // Test with a specific position
      return this.feeOptimiserRebalancingCronService.testVolumeCaptureForPosition(
        positionId,
        hoursCount,
      );
    } else if (tickLower && tickUpper) {
      // Test with custom tick range
      const lower = parseInt(tickLower, 10);
      const upper = parseInt(tickUpper, 10);
      return this.feeOptimiserRebalancingCronService.testVolumeCaptureForRange(
        lower,
        upper,
        hoursCount,
      );
    } else {
      // Test with current pool state
      return this.feeOptimiserRebalancingCronService.testCurrentPoolVolumeCapture(
        hoursCount,
      );
    }
  }

  @Public()
  @Get('test/optimal-range-detection')
  async testOptimalRangeDetection(
    @Query('rangeWidth') rangeWidth: string,
    @Query('hours') hours: string = '2',
    @Query('testVolatilityThreshold') testVolatilityThreshold?: string,
  ) {
    const rangeWidthNum = parseInt(rangeWidth, 10);
    const hoursCount = parseInt(hours, 10);
    const shouldTestVolatility = testVolatilityThreshold === 'true';

    if (isNaN(rangeWidthNum) || rangeWidthNum <= 0) {
      throw new Error('Invalid range width. Must be a positive number.');
    }

    return this.feeOptimiserRebalancingCronService.testOptimalRangeDetection(
      rangeWidthNum,
      hoursCount,
      shouldTestVolatility,
    );
  }
}
