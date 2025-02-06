import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Chat, ChatSchema } from './schemas/chat.schema';
import { JwtModule } from '@nestjs/jwt';
import { CrossmintJwtGuard } from './guards/jwt.guard';

@Module({
  imports: [
    ConfigModule.forRoot(),
    MongooseModule.forRoot(process.env.MONGODB_URI, {
      dbName: process.env.NODE_ENV === 'production' ? 'midas_prod' : 'test',
    }),
    MongooseModule.forFeature([{ name: Chat.name, schema: ChatSchema }]),
    JwtModule.register({
      global: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService, CrossmintJwtGuard],
})
export class AppModule {}
