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

@Controller('aerodrome')
export class AerodromeController {
  constructor(
    private readonly aerodromeService: AerodromeService,
    private readonly positionTrackingCronService: AerodromePositionTrackingCronService,
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
      100, // Fixed slippage of 1%
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
    },
  ) {
    const { positionId, reason } = body;
    return this.aerodromeService.rebalancePosition(positionId, reason);
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
}
