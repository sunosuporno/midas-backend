import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cron from 'node-cron';
import { TwitterApi, TweetV2 } from 'twitter-api-v2';
import { AppService } from './app.service';
import axios from 'axios';

interface ProcessedTweet {
  id: string;
  authorId: string;
  text: string;
}

interface TwitterApiResponse {
  data: Array<{
    id: string;
    author_id: string;
    text: string;
    created_at: string;
  }>;
}

@Injectable()
export class MentionCronService implements OnModuleInit {
  private twitterClient: TwitterApi;
  private lastProcessedTimestamp: string;
  private botUsername: string;
  private userId: string;

  constructor(
    private configService: ConfigService,
    private appService: AppService,
  ) {
    // Use Bearer Token for app-only auth
    const bearerToken = this.configService.get('TWITTER_BEARER_TOKEN');
    this.twitterClient = new TwitterApi(bearerToken);
    // Initialize with current time
    this.lastProcessedTimestamp = new Date().toISOString();
    this.botUsername = this.configService.get('TWITTER_BOT_USERNAME');
    this.userId = this.configService.get('TWITTER_USER_ID');
    this.userId = this.configService.get('TWITTER_USER_ID');
  }

  private cleanTweetText(text: string): string {
    // Create a regex that matches @username with optional spaces around it
    const handleRegex = new RegExp(
      `@${this.botUsername}\\s*|\\s*@${this.botUsername}`,
      'gi',
    );
    // Replace the handle with empty string and trim any extra spaces
    return text.replace(handleRegex, '').trim();
  }

  private async getTweetAuthors(tweets: TweetV2[]): Promise<ProcessedTweet[]> {
    try {
      const tweetIds = tweets.map((tweet) => tweet.id).join(',');

      const options = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.configService.get<string>('TWITTER_BEARER_TOKEN')}`,
        },
      };

      const response = await axios.get<TwitterApiResponse>(
        `https://api.twitter.com/2/tweets?ids=${tweetIds}&tweet.fields=author_id,created_at`,
        options,
      );

      if (!response.data?.data) {
        return [];
      }

      // Create a map of tweet ID to author ID and created_at
      const tweetAuthorMap = new Map(
        response.data.data.map((tweet) => [
          tweet.id,
          { authorId: tweet.author_id, createdAt: tweet.created_at },
        ]),
      );

      // Combine tweet data with author IDs and filter by timestamp
      return tweets
        .map((tweet) => {
          const tweetData = tweetAuthorMap.get(tweet.id);
          if (!tweetData) return null;

          // Only include tweets after our last processed timestamp
          if (
            new Date(tweetData.createdAt) <=
            new Date(this.lastProcessedTimestamp)
          ) {
            return null;
          }

          return {
            id: tweet.id,
            authorId: tweetData.authorId,
            text: this.cleanTweetText(tweet.text),
          };
        })
        .filter((tweet): tweet is ProcessedTweet => tweet !== null);
    } catch (error) {
      console.error('Error fetching tweet authors:', error);
      return [];
    }
  }

  async onModuleInit() {
    // Schedule a task to run every 15 minutes
    cron.schedule('*/2 * * * *', async () => {
      try {
        const mentions = await this.twitterClient.v2.userMentionTimeline(
          this.userId,
          {
            max_results: 100, // Increased to get more tweets
            start_time: this.lastProcessedTimestamp, // Only get tweets after last processed time
          },
        );

        const tweets = mentions.data?.data || [];
        if (tweets.length === 0) {
          return;
        }

        // Get author IDs for all tweets
        const processedTweets = await this.getTweetAuthors(tweets);

        if (processedTweets.length === 0) {
          return;
        }

        // Process all tweets in batch
        await this.appService.callAgentTwitter(processedTweets);

        // Update the last processed timestamp to current time
        this.lastProcessedTimestamp = new Date().toISOString();
      } catch (error) {
        // Error handling is done silently
        throw error;
      }
    });
  }
}
