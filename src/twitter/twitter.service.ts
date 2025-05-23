/*
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TwitterApi } from 'twitter-api-v2';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TwitterUser } from '../schemas/twitter-user.schema';
import { AppService } from '../app.service';

@Injectable()
export class TwitterService implements OnModuleInit {
  private twitterClient: TwitterApi;
  private twitterAppClient: TwitterApi;

  constructor(
    private configService: ConfigService,
    private appService: AppService,
    @InjectModel(TwitterUser.name)
    private twitterUserModel: Model<TwitterUser>,
  ) {
    // Debug logging
    console.log(
      'Twitter API Key:',
      this.configService.get('TWITTER_API_KEY') ? 'Present' : 'Missing',
    );
    console.log(
      'Twitter API Secret:',
      this.configService.get('TWITTER_API_SECRET') ? 'Present' : 'Missing',
    );
    console.log(
      'Twitter Access Token:',
      this.configService.get('TWITTER_ACCESS_TOKEN') ? 'Present' : 'Missing',
    );
    console.log(
      'Twitter Access Secret:',
      this.configService.get('TWITTER_ACCESS_SECRET') ? 'Present' : 'Missing',
    );
    console.log(
      'Twitter Bearer Token:',
      this.configService.get('TWITTER_BEARER_TOKEN') ? 'Present' : 'Missing',
    );
    console.log(
      'Twitter Bot Username:',
      this.configService.get('TWITTER_BOT_USERNAME') ? 'Present' : 'Missing',
    );

    // OAuth 1.0a client for user context operations (replies, etc.)
    this.twitterClient = new TwitterApi({
      appKey: this.configService.get('TWITTER_API_KEY'),
      appSecret: this.configService.get('TWITTER_API_SECRET'),
      accessToken: this.configService.get('TWITTER_ACCESS_TOKEN'),
      accessSecret: this.configService.get('TWITTER_ACCESS_SECRET'),
    });

    // OAuth 2.0 client for application-only operations (streaming)
    const bearerToken = this.configService.get('TWITTER_BEARER_TOKEN');
    if (!bearerToken) {
      throw new Error(
        'TWITTER_BEARER_TOKEN is not set in environment variables',
      );
    }
    this.twitterAppClient = new TwitterApi(bearerToken);
  }

  async onModuleInit() {
    console.log('Initializing Twitter service...');
    await this.startListening();
  }

  private async startListening() {
    try {
      console.log('Starting Twitter stream...');
      const rules = await this.twitterAppClient.v2.streamRules();
      console.log('Current stream rules:', rules);

      if (rules.data?.length) {
        console.log('Deleting existing rules:', rules.data);
        await this.twitterAppClient.v2.updateStreamRules({
          delete: { ids: rules.data.map((rule) => rule.id) },
        });
      }

      const botUsername = this.configService.get('TWITTER_BOT_USERNAME');
      if (!botUsername) {
        throw new Error(
          'TWITTER_BOT_USERNAME is not set in environment variables',
        );
      }

      // Add rule to listen for mentions
      console.log('Adding new stream rule for @' + botUsername);
      await this.twitterAppClient.v2.updateStreamRules({
        add: [{ value: `@${botUsername}` }],
      });

      console.log('Starting search stream...');
      const stream = await this.twitterAppClient.v2.searchStream({
        'tweet.fields': ['referenced_tweets', 'author_id'],
        expansions: ['referenced_tweets.id'],
      });

      stream.on('data', async (tweet) => {
        console.log('Received tweet:', tweet);
        await this.handleTweet(tweet);
      });

      stream.on('error', (error) => {
        console.error('Twitter stream error:', error);
      });

      console.log('Twitter stream started successfully');
    } catch (error) {
      console.error('Error starting Twitter stream:', error);
      throw error; // Re-throw to see the full error stack
    }
  }

  private async handleTweet(tweet: any) {
    try {
      const query = tweet.text
        .replace(`@${this.configService.get('TWITTER_BOT_USERNAME')}`, '')
        .trim();

      // Get or create user
      let twitterUser = await this.twitterUserModel.findOne({
        twitterId: tweet.author_id,
      });

      if (!twitterUser) {
        // Create new user with a default wallet address
        // In a real implementation, you'd want to implement a proper wallet creation flow
        twitterUser = await this.twitterUserModel.create({
          twitterId: tweet.author_id,
          twitterUsername: tweet.author_id, // You'll need to fetch the actual username
          walletAddress: '0x0000000000000000000000000000000000000000', // Default address
          isVerified: false,
        });

        // Reply with wallet setup instructions
        await this.twitterClient.v2.reply(
          'Welcome! Please set up your wallet by following the instructions at [your-wallet-setup-url]',
          tweet.id,
        );
        return;
      }

      // Call your existing agent
      const response = await this.appService.callAgentPublic(
        query,
        twitterUser.walletAddress,
        'base', // or whatever chain you want to default to
      );

      // Format response for Twitter
      const formattedResponse = this.formatResponseForTwitter(
        response.response,
      );

      // Post the response as a reply
      await this.twitterClient.v2.reply(formattedResponse, tweet.id);

      // Update last interaction
      await this.twitterUserModel.updateOne(
        { twitterId: tweet.author_id },
        { lastInteraction: new Date() },
      );
    } catch (error) {
      console.error('Error handling tweet:', error);
      await this.twitterClient.v2.reply(
        'Sorry, I encountered an error processing your request. Please try again later.',
        tweet.id,
      );
    }
  }

  private formatResponseForTwitter(response: string): string {
    // Format the response to fit Twitter's character limit
    // You might want to split long responses into threads
    if (response.length <= 280) {
      return response;
    }

    // For longer responses, create a thread
    return response.substring(0, 277) + '...';
  }

  async createThread(tweetId: string, content: string) {
    // Implement thread creation logic for long responses
    const chunks = this.splitIntoChunks(content, 280);
    let currentTweetId = tweetId;

    for (const chunk of chunks) {
      const reply = await this.twitterClient.v2.reply(chunk, currentTweetId);
      currentTweetId = reply.data.id;
    }
  }

  private splitIntoChunks(str: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < str.length; i += size) {
      chunks.push(str.slice(i, i + size));
    }
    return chunks;
  }
}
*/
