// import { Module } from '@nestjs/common';
// import { MongooseModule } from '@nestjs/mongoose';
// import { ConfigModule } from '@nestjs/config';
// import { TwitterService } from './twitter.service';
// import { TwitterUser, TwitterUserSchema } from '../schemas/twitter-user.schema';
// import { AppService } from '../app.service';
// import { Chat, ChatSchema } from '../schemas/chat.schema';
// import { ApiKey, ApiKeySchema } from '../schemas/api-key.schema';

// @Module({
//   imports: [
//     ConfigModule,
//     MongooseModule.forFeature([
//       { name: TwitterUser.name, schema: TwitterUserSchema },
//       { name: Chat.name, schema: ChatSchema },
//       { name: ApiKey.name, schema: ApiKeySchema },
//     ]),
//   ],
//   providers: [TwitterService, AppService],
//   exports: [TwitterService],
// })
// export class TwitterModule {}
