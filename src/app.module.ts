import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Chat, ChatSchema } from './schemas/chat.schema';
import { JwtModule } from '@nestjs/jwt';
import { CrossmintJwtGuard } from './guards/jwt.guard';
import { ApiKey, ApiKeySchema } from './schemas/api-key.schema';
// import { TwitterModule } from './twitter/twitter.module';
// import { MentionCronService } from './mention-cron.service';
import { AerodromeRebalancingCronService } from './aerodrome-rebalancing-cron.service';
import { AerodromePositionTrackingCronService } from './aerodrome-position-tracking-cron.service';
import { AerodromeFeeOptimiserRebalancingCronService } from './aerodrome-fee-optimiser-rebalancing-cron.service';
import { AerodromeVolumeBlockCronService } from './aerodrome-volume-block-cron.service';
import { User, UserSchema } from './schemas/user.schema';
import { PendingTip, PendingTipSchema } from './schemas/pending-tip.schema';
import { AerodromeController } from './aerodrome/aerodrome.controller';
import { AerodromeService } from './aerodrome/aerodrome.service';
import { AerodromeSubgraphService } from './aerodrome/subgraph.service';
import {
  AerodromePosition,
  AerodromePositionSchema,
} from './aerodrome/schemas/aerodrome-position.schema';
import {
  VolumeBlock,
  VolumeBlockSchema,
} from './aerodrome/schemas/volume-block.schema';
import {
  DailyFees,
  DailyFeesSchema,
} from './aerodrome/schemas/daily-fees.schema';

@Module({
  imports: [
    ConfigModule.forRoot(),
    MongooseModule.forRoot(process.env.MONGODB_URI, {
      dbName: process.env.NODE_ENV === 'production' ? 'midas_prod' : 'test',
    }),
    MongooseModule.forFeature([
      { name: Chat.name, schema: ChatSchema },
      { name: ApiKey.name, schema: ApiKeySchema },
      { name: User.name, schema: UserSchema },
      { name: PendingTip.name, schema: PendingTipSchema },
      { name: AerodromePosition.name, schema: AerodromePositionSchema },
      { name: VolumeBlock.name, schema: VolumeBlockSchema },
      { name: DailyFees.name, schema: DailyFeesSchema },
    ]),
    JwtModule.register({
      global: true,
    }),
    // TwitterModule,
  ],
  controllers: [AppController, AerodromeController],
  providers: [
    AppService,
    AerodromeService,
    CrossmintJwtGuard,
    // MentionCronService,
    AerodromeRebalancingCronService,
    AerodromePositionTrackingCronService,
    AerodromeFeeOptimiserRebalancingCronService,
    AerodromeVolumeBlockCronService,
    AerodromeSubgraphService,
  ],
})
export class AppModule {}
