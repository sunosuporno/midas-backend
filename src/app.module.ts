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
import { MentionCronService } from './mention-cron.service';
import { User, UserSchema } from './schemas/user.schema';
import { PendingTip, PendingTipSchema } from './schemas/pending-tip.schema';

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
    ]),
    JwtModule.register({
      global: true,
    }),
    // TwitterModule,
  ],
  controllers: [AppController],
  providers: [AppService, CrossmintJwtGuard, MentionCronService],
})
export class AppModule {}
