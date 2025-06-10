import { Injectable, HttpException } from '@nestjs/common';
import { CreateDelegatedKeyDto } from './dto/create-delegated-key.dto';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { ApproveDelegateDto } from './dto/approve-delegate.dto';
import { generateText } from 'ai';
import { getOnChainTools } from '@goat-sdk/adapter-vercel-ai';
import { crossmint } from '@goat-sdk/crossmint';
import {
  USDC,
  USDT,
  WETH,
  ezETH,
  wrsETH,
  erc20,
  MODE,
} from '../workspace/goat-sdk/plugins/erc20/src';
import { tokenInfo } from '../workspace/goat-sdk/plugins/token-info/src';
import { zeroEx } from '../workspace/goat-sdk/plugins/0x/src';
import { openai } from '@ai-sdk/openai';
import { tipping } from '../workspace/goat-sdk/plugins/tipping/src';
import { ChainType, SmartWalletChainType } from './dto/agent-call.dto';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Chat } from './schemas/chat.schema';
import { v4 as uuidv4 } from 'uuid';
import { createCipheriv, randomBytes, createHash } from 'crypto';
import { ApiKey } from './schemas/api-key.schema';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, arbitrum } from 'viem/chains';
import { viem } from '@goat-sdk/wallet-viem';
import { networkTools } from './config/network-tools.config';
import { isSmartWalletChain } from './config/chains.config';
import { SupportedChainType } from './config/chains.config';
import { User } from './schemas/user.schema';
import { PendingTip } from './schemas/pending-tip.schema';
import { TwitterApi } from 'twitter-api-v2';
import { FarcasterConnectionDto } from './dto/farcaster-connection.dto';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKey>,
    @InjectModel(User.name) private userModel: Model<User>,
    @InjectModel(PendingTip.name) private pendingTipModel: Model<PendingTip>,
    private configService: ConfigService,
  ) {}

  private readonly ENCRYPTION_KEY =
    this.configService.get<string>('ENCRYPTION_KEY');

  private async updateUserWithTwitterDetails(
    crossmintId: string,
    twitterId: string,
    twitterUsername: string,
    wallet?: string,
    chain?: string,
  ) {
    try {
      // Use a transaction to ensure atomicity
      const session = await this.userModel.startSession();
      await session.withTransaction(async () => {
        // Try to find user by crossmintId first
        const existingUser = await this.userModel
          .findOne({ crossmintId })
          .session(session);

        if (!existingUser) {
          // Create new user with all details
          await this.userModel.create(
            [
              {
                crossmintId,
                twitterId,
                twitterUsername,
                wallet,
                approvedChains: chain ? [chain] : [],
              },
            ],
            { session },
          );
        } else {
          // For existing users, only update the chain
          if (chain) {
            await this.userModel.updateOne(
              { _id: existingUser._id },
              { $addToSet: { approvedChains: chain } },
              { session },
            );
          }
        }
      });
    } catch (error) {
      console.error('Error updating user with Twitter details:', error);
      throw new HttpException('Failed to update user details', 500);
    }
  }

  private encrypt(text: string): string {
    // Generate a deterministic IV based on the input text
    const hash = createHash('sha256').update(text).digest();
    const iv = hash.slice(0, 16); // Use first 16 bytes as IV
    const key = Buffer.from(this.ENCRYPTION_KEY).slice(0, 32);

    const cipher = createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  async generateApiKey(walletAddress: string): Promise<{ apiKey: string }> {
    try {
      console.log('=== Generating API Key ===');
      console.log('Wallet Address:', walletAddress);

      // Check if wallet already has an API key
      const existingKey = await this.apiKeyModel.findOne({ walletAddress });
      if (existingKey) {
        console.log('API key already exists for wallet');
        throw new HttpException('API key already exists for this wallet', 400);
      }

      const apiKey = randomBytes(32).toString('hex');
      console.log('Generated API Key:', apiKey);

      const encryptedKey = this.encrypt(apiKey);
      console.log('Encrypted Key:', encryptedKey);

      const apiKeyDoc = await this.apiKeyModel.create({
        walletAddress,
        encryptedKey,
      });
      console.log('Saved to database with ID:', apiKeyDoc._id);

      return { apiKey };
    } catch (error) {
      console.error('Error generating API key:', error);
      throw new HttpException(
        error.message || 'Failed to generate API key',
        error.status || 500,
      );
    }
  }

  async validateApiKey(apiKey: string): Promise<string> {
    if (!apiKey) {
      throw new HttpException('API key is required', 401);
    }
    console.log('API Key:', apiKey);
    const encryptedKey = this.encrypt(apiKey);
    console.log('Encrypted Key:', encryptedKey);
    const keyDoc = await this.apiKeyModel.findOne({ encryptedKey });

    if (!keyDoc) {
      throw new HttpException('Invalid API key', 401);
    }

    return keyDoc.walletAddress;
  }

  getHello(): string {
    return 'gm world!';
  }

  async createDelegatedKey(
    walletLocator: string,
    createDelegatedKeyDto: CreateDelegatedKeyDto,
  ) {
    try {
      console.log('=== Assign Delegate Key Request ===');
      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const signerWallet = this.configService.get<string>('SIGNER_WALLET');

      const expiresAt = createDelegatedKeyDto.expiresAt
        ? Number(createDelegatedKeyDto.expiresAt)
        : undefined;

      if (createDelegatedKeyDto.expiresAt && isNaN(expiresAt)) {
        throw new HttpException('Invalid expiresAt timestamp', 400);
      }

      // Validate chain
      if (!createDelegatedKeyDto.chain) {
        throw new HttpException('Chain is required', 400);
      }

      console.log('chain:', createDelegatedKeyDto.chain);

      const body = {
        chain: createDelegatedKeyDto.chain,
        expiresAt: expiresAt,
        signer: signerWallet,
      };

      console.log('body:', body);

      // Step 1: Create initial delegated key
      console.log('Step 1: Registering delegated key');
      const initialResponse = await axios.post(
        `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/signers`,
        body,
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
        },
      );
      console.log(
        'Initial Response:',
        JSON.stringify(initialResponse.data, null, 2),
      );

      const chainAuth =
        initialResponse.data.chains[createDelegatedKeyDto.chain];
      if (!chainAuth?.approvals?.pending?.[0]) {
        throw new HttpException('No pending approval found', 400);
      }

      // Handle user details if provided
      if (createDelegatedKeyDto.userDetails) {
        const { crossmintId, twitterId, twitterUsername, wallet } =
          createDelegatedKeyDto.userDetails;

        // Validate required fields
        if (!crossmintId) {
          throw new HttpException('Crossmint ID is required', 400);
        }

        // Validate wallet address format if provided
        if (wallet && !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
          throw new HttpException('Invalid wallet address format', 400);
        }

        // Validate Twitter ID format if provided
        if (twitterId && !/^\d+$/.test(twitterId)) {
          throw new HttpException('Invalid Twitter ID format', 400);
        }

        // Update user with Twitter details
        await this.updateUserWithTwitterDetails(
          crossmintId,
          twitterId,
          twitterUsername,
          wallet,
          createDelegatedKeyDto.chain,
        );
      } else {
        // If userDetails not present, update approvedChains by wallet address
        try {
          const result = await this.userModel.updateOne(
            { wallet: walletLocator },
            { $addToSet: { approvedChains: createDelegatedKeyDto.chain } },
          );

          if (result.matchedCount === 0) {
            console.warn(`No user found with wallet address: ${walletLocator}`);
          }
        } catch (dbError) {
          console.error('Database operation failed:', dbError);
          throw new HttpException('Failed to update user details', 500);
        }
      }

      const result = {
        messageToSign: chainAuth.approvals.pending[0].message,
        signer: chainAuth.approvals.pending[0].signer,
        authorizationId: chainAuth.id,
      };
      console.log(
        '=== Response to Frontend ===\n',
        JSON.stringify(result, null, 2),
      );
      return result;
    } catch (error) {
      console.error('=== Error in createDelegatedKey ===');
      console.error(
        'Error details:',
        JSON.stringify(
          {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
          },
          null,
          2,
        ),
      );
      throw new HttpException(
        error.response?.data?.message || 'Failed to create delegated key',
        error.response?.status || 500,
      );
    }
  }

  async approveDelegate(approveDelegateDto: ApproveDelegateDto) {
    try {
      console.log('=== Approving Delegate ===');
      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const { walletLocator, signatureId, signer, signingResult } =
        approveDelegateDto;

      console.log('Approval Request:', {
        approvals: [
          {
            signer: signer,
            metadata: signingResult.metadata,
            signature: {
              r: signingResult.signature.r.toString(),
              s: signingResult.signature.s.toString(),
            },
          },
        ],
      });

      const response = await axios.post(
        `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/signatures/${signatureId}/approvals`,
        {
          approvals: [
            {
              signer: signer,
              metadata: signingResult.metadata,
              signature: {
                r: signingResult.signature.r.toString(),
                s: signingResult.signature.s.toString(),
              },
            },
          ],
        },
        {
          headers: {
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json',
          },
        },
      );

      console.log('Approval Response:', JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      console.error('=== Error in approveDelegate ===');
      console.error(
        'Error details:',
        JSON.stringify(
          {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status,
          },
          null,
          2,
        ),
      );
      throw new HttpException(
        error.response?.data?.message || 'Failed to approve delegate',
        error.response?.status || 500,
      );
    }
  }

  async createChatSession(walletAddress: string) {
    console.log('=== Creating Chat Session ===');
    const sessionId = uuidv4();
    const chat = new this.chatModel({
      walletAddress,
      sessionId,
      messages: [],
    });
    await chat.save();
    return { sessionId };
  }

  async saveUserMessage(
    walletAddress: string,
    sessionId: string,
    message: {
      content: string;
      chain: ChainType;
    },
  ) {
    return this.chatModel.findOneAndUpdate(
      { walletAddress, sessionId },
      {
        $push: {
          messages: {
            role: 'user',
            content: message.content,
            chain: message.chain,
            timestamp: new Date(),
          },
        },
      },
    );
  }

  async getChatSessions(walletAddress: string) {
    console.log('=== Getting Chat Sessions ===');
    console.log('Wallet Address:', walletAddress);

    try {
      const sessions = await this.chatModel
        .find({ walletAddress })
        .select('sessionId createdAt')
        .sort({ createdAt: -1 });

      console.log('Found sessions:', sessions); // Debug log

      if (!sessions || sessions.length === 0) {
        console.log('No sessions found for wallet address');
        return [];
      }

      return sessions;
    } catch (error) {
      console.error('Error fetching chat sessions:', error);
      throw error;
    }
  }

  async getChatHistory(walletAddress: string, sessionId: string) {
    return this.chatModel.findOne({ walletAddress, sessionId });
  }

  private getCapabilitiesResponse(
    chain: ChainType,
    detailed: boolean = false,
  ): string {
    const networkConfig = networkTools[chain];
    if (!networkConfig) {
      return `I'm sorry, I don't have information about my capabilities on this network.`;
    }

    const availableTools = networkConfig.available;
    const descriptions = networkConfig.descriptions;

    let response = `I'm Midas, your DeFi assistant on the ${chain.toUpperCase()} network! Here's what I can help you with:\n\n`;

    if (!detailed) {
      // Basic capabilities list
      response += availableTools
        .map((tool) => `• ${descriptions[tool].basic}`)
        .join('\n');
      response +=
        '\n\nFor more details about any specific feature, just ask! For example: "How do I swap tokens?" or "How does voting work?"';
    } else {
      // Detailed capabilities for all tools
      availableTools.forEach((tool) => {
        response += `\n📌 ${descriptions[tool].basic}:\n`;
        Object.entries(descriptions[tool].details).forEach(
          ([, explanation]) => {
            response += `   • ${explanation}\n`;
          },
        );
      });
    }

    return response;
  }

  private getToolHelp(chain: ChainType, query: string): string | null {
    const networkConfig = networkTools[chain];
    if (!networkConfig) return null;

    // Map common questions to tools
    const toolMatches = {
      swap: 'zeroEx',
      exchange: 'zeroEx',
      trade: 'zeroEx',
      vote: 'modeVoting',
      proposal: 'modeVoting',
      governance: 'modeVoting',
      balance: 'erc20',
      transfer: 'erc20',
      send: 'erc20',
      stake: 'kim',
      deposit: 'ironclad',
      withdraw: 'ironclad',
      price: 'tokenInfo',
      market: 'tokenInfo',
      pool: 'merchantMoe',
    };

    // Find which tool the question is about
    const matchedTool = Object.entries(toolMatches).find(([key]) =>
      query.toLowerCase().includes(key),
    )?.[1];

    if (!matchedTool || !networkConfig.available.includes(matchedTool)) {
      return null;
    }

    const toolDesc = networkConfig.descriptions[matchedTool];
    let response = `Here's how you can ${query.toLowerCase().includes('how') ? 'use' : 'work with'} ${matchedTool}:\n\n`;
    Object.values(toolDesc.details).forEach((detail) => {
      response += `• ${detail}\n`;
    });

    return response;
  }

  async callAgent(
    prompt: string,
    walletAddress: string,
    chain: SmartWalletChainType,
    sessionId?: string,
  ) {
    try {
      console.log('=== Calling Agent ===');
      console.log('Chain:', chain);
      console.log('Wallet Address:', walletAddress);

      // Check if user has approved this chain
      const user = await this.userModel.findOne({ wallet: walletAddress });
      if (!user?.approvedChains?.includes(chain)) {
        const errorMessage = `Please approve the ${chain} network first before using it.`;
        // Save the error message to chat history if sessionId exists
        if (sessionId) {
          await this.chatModel.findOneAndUpdate(
            { walletAddress, sessionId },
            {
              $push: {
                messages: {
                  role: 'assistant',
                  content: errorMessage,
                  chain,
                  timestamp: new Date(),
                },
              },
            },
          );
        }
        return { response: errorMessage };
      }

      if (!isSmartWalletChain(chain)) {
        throw new HttpException(
          'This chain does not support smart wallet operations',
          400,
        );
      }

      // Get the chain configuration
      const chainConfig = this.chainConfigMap[chain];
      if (!chainConfig) {
        console.error('Unsupported chain:', chain);
        throw new Error(`Unsupported chain: ${chain}`);
      }
      console.log('Chain Configuration:', {
        chain: chain,
        rpcUrl: chainConfig.rpcUrl,
        chainObject: chainConfig.chain,
      });

      // Fetch chat history if sessionId is provided
      let contextualPrompt = prompt;
      if (sessionId) {
        const chatHistory = await this.chatModel.findOne({
          walletAddress,
          sessionId,
        });
        if (chatHistory && chatHistory.messages.length > 0) {
          // Format previous messages into a conversation context
          const MAX_PREVIOUS_MESSAGES = 5; // Adjust this number as needed
          const recentMessages = chatHistory.messages
            .slice(-MAX_PREVIOUS_MESSAGES) // Take only the most recent messages
            .map(
              (msg) =>
                `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
            )
            .join('\n');

          // Combine context with new prompt
          contextualPrompt = `Previous conversation:\n${recentMessages}\n\nNew message: ${prompt}`;
        }
      }

      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const walletSignerSecretKey = this.configService.get<string>(
        'WALLET_SIGNER_SECRET_KEY',
      );
      const alchemyApiKey = chainConfig.rpcUrl; // Use chain-specific RPC URL

      if (
        !apiKey ||
        !walletSignerSecretKey ||
        !alchemyApiKey ||
        !walletAddress
      ) {
        throw new Error('Missing required environment variables');
      }

      const { evmSmartWallet } = crossmint(apiKey);

      console.log('Creating smart wallet with configuration:', {
        address: walletAddress,
        chain: chain,
        provider: alchemyApiKey,
      });

      const tools = await getOnChainTools({
        wallet: await evmSmartWallet({
          address: walletAddress,
          signer: {
            secretKey: walletSignerSecretKey as `0x${string}`,
          },
          chain: chain as SmartWalletChainType,
          provider: alchemyApiKey,
        }),
        plugins: [
          tokenInfo({
            coingeckoApiKey:
              this.configService.get<string>('COINGECKO_API_KEY'),
          }),
          erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
          zeroEx({
            apiKey: (() => {
              const key = this.configService.get<string>('ZEROX_API_KEY');
              console.log(
                'Debug - ZEROX_API_KEY value:',
                key ? 'present' : 'undefined',
              );
              return key;
            })(),
          }),
          tipping(
            this.userModel,
            this.pendingTipModel,
            this.configService.get<string>('RPC_URL'),
            this.configService.get<string>('SAFE_WALLET_SIGNER_PRIVATE_KEY'),
          ),
        ],
      });

      console.log('\n-------------------\n');
      console.log('TOOLS CALLED');
      console.log('\n-------------------\n');
      try {
        const result = await generateText({
          model: openai('gpt-4o'),
          tools: tools,
          system:
            'Your name is Midas, named after the fabled King whose touch turned things to gold. As an agent, you are the best DeFi assistant there is who can do all types of DeFi actions like swapping, staking, voting, etc. When you are asked to do any action, search the tools for the description which matches the action you are asked to do. If you find a match, use the tool to perform the action. Also, if a tool mentions to not call or call another tool in its description, make sure you follow the instructions. Send the data in markdown format.',
          maxSteps: 12,
          prompt: contextualPrompt,
          onStepFinish: (event) => {
            console.log(event.toolResults);
          },
        });

        console.log('\n-------------------\n');
        console.log('RESPONSE');
        console.log('\n-------------------\n');
        console.log(result.text);
        console.log('\n-------------------\n');

        // Save the conversation
        if (sessionId) {
          await this.chatModel.findOneAndUpdate(
            { walletAddress, sessionId },
            {
              $push: {
                messages: {
                  role: 'assistant',
                  content: result.text,
                  chain,
                  timestamp: new Date(),
                },
              },
            },
          );
        }
        return {
          response: result.text,
        };
      } catch (error) {
        console.error('Error in generateText:', error);
        throw new HttpException(
          error.message || 'Failed to process agent request',
          error.response?.status || 500,
        );
      }
    } catch (error) {
      console.error('Error in callAgent:', {
        error: error.message,
        stack: error.stack,
        chain: chain,
        walletAddress: walletAddress,
      });
      throw new HttpException(
        error.message || 'Failed to process agent request',
        error.response?.status || 500,
      );
    }
  }

  async checkDelegated(walletAddress: string) {
    try {
      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const signerWallet = this.configService.get<string>('SIGNER_WALLET');

      try {
        const response = await axios.get(
          `https://www.crossmint.com/api/2022-06-09/wallets/${walletAddress}/signers/${signerWallet}`,
          {
            headers: {
              'x-api-key': apiKey,
            },
          },
        );

        return response.data;
      } catch (error) {
        if (error.response?.status === 404) {
          // Extract the address from the SIGNER_WALLET env variable
          // Format is typically "evm-keypair:0x..."
          const [type, address] = signerWallet.split(':');

          // Return a standardized response for non-delegated cases
          return {
            type: type,
            address: address,
            locator: signerWallet,
            expiresAt: '0',
            chains: {},
          };
        }
        throw error; // Re-throw if it's not a 404 error
      }
    } catch (error) {
      console.error('Error in checkDelegated:', error);
      throw new HttpException(
        error.response?.data?.message || 'Failed to check delegation',
        error.response?.status || 500,
      );
    }
  }

  async callAgentPublic(
    prompt: string,
    walletAddress: string,
    chain: SmartWalletChainType,
  ) {
    try {
      console.log('=== Calling Agent (Public) ===');
      console.log('Using wallet address:', walletAddress);
      console.log('chain', chain);

      // Check if user has approved this chain
      const user = await this.userModel.findOne({ wallet: walletAddress });
      if (!user?.approvedChains?.includes(chain)) {
        const errorMessage = `Please approve the ${chain} network first before using it.`;
        // Get the latest session or create a new one
        const latestChat = await this.chatModel
          .findOne({ walletAddress })
          .sort({ createdAt: -1 });
        const sessionId = latestChat?.sessionId || uuidv4();

        // Save the error message to chat history
        await this.chatModel.findOneAndUpdate(
          { walletAddress, sessionId },
          {
            $push: {
              messages: {
                role: 'assistant',
                content: errorMessage,
                chain,
                timestamp: new Date(),
              },
            },
          },
          { upsert: true },
        );
        return { response: errorMessage, sessionId };
      }

      // Get the chain configuration
      const chainConfig = this.chainConfigMap[chain];
      if (!chainConfig) {
        console.error('Unsupported chain:', chain);
        throw new HttpException(
          'This chain does not support smart wallet operations',
          400,
        );
      }
      console.log('Chain Configuration:', {
        chain: chain,
        rpcUrl: chainConfig.rpcUrl,
        chainObject: chainConfig.chain,
      });

      // Get the latest session or create a new one
      const latestChat = await this.chatModel
        .findOne({ walletAddress })
        .sort({ createdAt: -1 });

      const sessionId = latestChat?.sessionId || uuidv4();

      // Format chat history if it exists
      let contextualPrompt = prompt;
      if (latestChat && latestChat.messages.length > 0) {
        const MAX_PREVIOUS_MESSAGES = 5;
        const recentMessages = latestChat.messages
          .slice(-MAX_PREVIOUS_MESSAGES)
          .map(
            (msg) =>
              `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
          )
          .join('\n');

        contextualPrompt = `Previous conversation:\n${recentMessages}\n\nNew message: ${prompt}`;
      }

      // Save the user's message
      await this.chatModel.findOneAndUpdate(
        { walletAddress, sessionId },
        {
          $push: {
            messages: {
              role: 'user',
              content: prompt,
              chain,
              timestamp: new Date(),
            },
          },
        },
        { upsert: true },
      );

      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const walletSignerSecretKey = this.configService.get<string>(
        'WALLET_SIGNER_SECRET_KEY',
      );
      const alchemyApiKey = chainConfig.rpcUrl; // Use chain-specific RPC URL

      if (
        !apiKey ||
        !walletSignerSecretKey ||
        !alchemyApiKey ||
        !walletAddress
      ) {
        throw new Error('Missing required environment variables');
      }

      console.log('Creating smart wallet with configuration:', {
        address: walletAddress,
        chain: chainConfig.chain,
        provider: alchemyApiKey,
      });

      const { evmSmartWallet } = crossmint(apiKey);

      const tools = await getOnChainTools({
        wallet: await evmSmartWallet({
          address: walletAddress,
          signer: {
            secretKey: walletSignerSecretKey as `0x${string}`,
          },
          chain: chain as SmartWalletChainType,
          provider: alchemyApiKey,
        }),
        plugins: [
          tokenInfo({
            coingeckoApiKey:
              this.configService.get<string>('COINGECKO_API_KEY'),
          }),
          erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
          zeroEx({
            apiKey: this.configService.get<string>('ZEROX_API_KEY'),
          }),
          tipping(
            this.userModel,
            this.pendingTipModel,
            this.configService.get<string>('RPC_URL'),
            this.configService.get<string>('SAFE_WALLET_SIGNER_PRIVATE_KEY'),
          ),
        ],
      });

      console.log('\n-------------------\n');
      console.log('TOOLS CALLED');
      console.log('\n-------------------\n');
      try {
        const result = await generateText({
          model: openai('gpt-4o'),
          tools: tools,
          system:
            'Your name is Midas, named after the fabled King whose touch turned things to gold. As an agent, you are the best DeFi assistant there is who can do all types of DeFi actions like swapping, staking, voting, etc. When you are asked to do any action, search the tools for the description which matches the action you are asked to do. If you find a match, use the tool to perform the action. Also, if a tool mentions to not call or call another tool in its description, make sure you follow the instructions. Send the data in markdown format.',
          maxSteps: 12,
          prompt: contextualPrompt,
          onStepFinish: (event) => {
            console.log(event.toolResults);
          },
        });

        console.log('\n-------------------\n');
        console.log('RESPONSE');
        console.log('\n-------------------\n');
        console.log(result.text);
        console.log('\n-------------------\n');

        // Save the assistant's response
        await this.chatModel.findOneAndUpdate(
          { walletAddress, sessionId },
          {
            $push: {
              messages: {
                role: 'assistant',
                content: result.text,
                chain,
                timestamp: new Date(),
              },
            },
          },
        );

        return {
          response: result.text,
          sessionId,
        };
      } catch (error) {
        console.error('Error in generateText:', error);
        throw new HttpException(
          error.message || 'Failed to process agent request',
          error.response?.status || 500,
        );
      }
    } catch (error) {
      console.error('Error in callAgentPublic:', {
        error: error.message,
        stack: error.stack,
        chain: chain,
        walletAddress: walletAddress,
      });
      throw new HttpException(
        error.message || 'Failed to process agent request',
        error.response?.status || 500,
      );
    }
  }

  // Define a map for chain configurations
  private readonly chainConfigMap: Record<
    string,
    { rpcUrl: string; chain: any }
  > = {
    arbitrum: {
      rpcUrl: process.env.ALCHEMY_API_KEY_ARBITRUM,
      chain: arbitrum,
    },
    base: {
      rpcUrl: process.env.ALCHEMY_API_KEY_BASE,
      chain: base,
    },
    // Add more chains as needed
  };

  async callAgentViem(
    prompt: string,
    chain: SupportedChainType,
    privateKey: string,
  ) {
    try {
      console.log('=== Calling Agent (Viem) ===');
      console.log('chain', chain);

      // Get the chain configuration
      const chainConfig = this.chainConfigMap[chain];
      if (!chainConfig) {
        const errorMessage = `Unsupported chain: ${chain}`;
        // Get the latest session or create a new one
        const latestChat = await this.chatModel
          .findOne({
            walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
              .address,
          })
          .sort({ createdAt: -1 });
        const sessionId = latestChat?.sessionId || uuidv4();

        // Save the error message to chat history
        await this.chatModel.findOneAndUpdate(
          {
            walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
              .address,
            sessionId,
          },
          {
            $push: {
              messages: {
                role: 'assistant',
                content: errorMessage,
                chain,
                timestamp: new Date(),
              },
            },
          },
          { upsert: true },
        );
        return { response: errorMessage, sessionId };
      }

      // Normalize private key format
      const normalizedPrivateKey = privateKey.startsWith('0x')
        ? privateKey
        : `0x${privateKey}`;
      const account = privateKeyToAccount(
        normalizedPrivateKey as `0x${string}`,
      );

      console.log('RPC URL:', chainConfig.rpcUrl);

      const walletClient = createWalletClient({
        account: account as any,
        transport: http(chainConfig.rpcUrl),
        chain: chainConfig.chain as any,
      });

      console.log('running');
      console.log(this.configService.get<string>('COINGECKO_API_KEY'));

      const tools = await getOnChainTools({
        wallet: viem(walletClient as any),
        plugins: [
          tokenInfo({
            coingeckoApiKey:
              this.configService.get<string>('COINGECKO_API_KEY'),
          }),
          zeroEx({
            apiKey: this.configService.get<string>('ZEROX_API_KEY'),
          }),
          tipping(
            this.userModel,
            this.pendingTipModel,
            chainConfig.rpcUrl,
            this.configService.get<string>('SAFE_WALLET_SIGNER_PRIVATE_KEY'),
          ),
        ],
      });

      console.log('\n-------------------\n');
      console.log('TOOLS CALLED');
      console.log('\n-------------------\n');
      try {
        const result = await generateText({
          model: openai('gpt-4o'),
          tools: tools,
          system:
            'Your name is Midas, named after the fabled King whose touch turned things to gold. As an agent, you are the best DeFi assistant there is who can do all types of DeFi actions like swapping, staking, voting, etc. When you are asked to do any action, search the tools for the description which matches the action you are asked to do. If you find a match, use the tool to perform the action. Also, if a tool mentions to not call or call another tool in its description, make sure you follow the instructions. Send the data in markdown format.',
          maxSteps: 12,
          prompt: prompt,
          onStepFinish: (event) => {
            console.log(event.toolResults);
          },
        });

        console.log('\n-------------------\n');
        console.log('RESPONSE');
        console.log('\n-------------------\n');
        console.log(result.text);
        console.log('\n-------------------\n');

        return {
          response: result.text,
        };
      } catch (error) {
        console.error('Error in generateText:', error);
        const errorMessage = error.message || 'Failed to process agent request';
        // Get the latest session or create a new one
        const latestChat = await this.chatModel
          .findOne({
            walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
              .address,
          })
          .sort({ createdAt: -1 });
        const sessionId = latestChat?.sessionId || uuidv4();

        // Save the error message to chat history
        await this.chatModel.findOneAndUpdate(
          {
            walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
              .address,
            sessionId,
          },
          {
            $push: {
              messages: {
                role: 'assistant',
                content: errorMessage,
                chain,
                timestamp: new Date(),
              },
            },
          },
          { upsert: true },
        );
        return { response: errorMessage, sessionId };
      }
    } catch (error) {
      console.error('Error in callAgentViem:', error);
      const errorMessage = error.message || 'Failed to process agent request';
      // Get the latest session or create a new one
      const latestChat = await this.chatModel
        .findOne({
          walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
            .address,
        })
        .sort({ createdAt: -1 });
      const sessionId = latestChat?.sessionId || uuidv4();

      // Save the error message to chat history
      await this.chatModel.findOneAndUpdate(
        {
          walletAddress: privateKeyToAccount(privateKey as `0x${string}`)
            .address,
          sessionId,
        },
        {
          $push: {
            messages: {
              role: 'assistant',
              content: errorMessage,
              chain,
              timestamp: new Date(),
            },
          },
        },
        { upsert: true },
      );
      return { response: errorMessage, sessionId };
    }
  }

  async callAgentTwitter(
    tweets: { id: string; authorId: string; text: string }[],
  ) {
    try {
      console.log('=== Processing Twitter Mentions Batch ===');
      console.log('Number of tweets:', tweets.length);

      // Initialize Twitter client with OAuth 1.0a for write actions (replies)
      const twitterClient = new TwitterApi({
        appKey: this.configService.get<string>('TWITTER_API_KEY'),
        appSecret: this.configService.get<string>('TWITTER_API_SECRET'),
        accessToken: this.configService.get<string>('TWITTER_ACCESS_TOKEN'),
        accessSecret: this.configService.get<string>('TWITTER_ACCESS_SECRET'),
      });

      // Process each tweet
      const results = await Promise.all(
        tweets.map(async (tweet) => {
          try {
            // Find user by Twitter ID
            const user = await this.userModel.findOne({
              twitterId: tweet.authorId,
            });
            if (!user || !user.wallet) {
              console.error(
                `No wallet found for Twitter user ${tweet.authorId}`,
              );
              const errorMessage =
                'No wallet found. Please connect your wallet first.';
              // Get the latest session or create a new one
              const latestChat = await this.chatModel
                .findOne({ walletAddress: user?.wallet })
                .sort({ createdAt: -1 });
              const sessionId = latestChat?.sessionId || uuidv4();

              // Save the error message to chat history
              if (user?.wallet) {
                await this.chatModel.findOneAndUpdate(
                  { walletAddress: user.wallet, sessionId },
                  {
                    $push: {
                      messages: {
                        role: 'assistant',
                        content: errorMessage,
                        chain: 'base', // Default chain since we don't know which one they want
                        timestamp: new Date(),
                      },
                    },
                  },
                  { upsert: true },
                );
              }
              await twitterClient.v2.reply(errorMessage, tweet.id);
              return null;
            }

            // Extract chain from the message using "on [network]" pattern
            const chainMatch = tweet.text.match(/on\s+(arbitrum|base)/i);
            const requestedChain = chainMatch
              ? chainMatch[1].toLowerCase()
              : null;

            if (!requestedChain) {
              const errorMessage =
                "Please specify which network you want to use by adding 'on base' or 'on arbitrum' to your message.";
              // Get the latest session or create a new one
              const latestChat = await this.chatModel
                .findOne({ walletAddress: user.wallet })
                .sort({ createdAt: -1 });
              const sessionId = latestChat?.sessionId || uuidv4();

              // Save the error message to chat history
              await this.chatModel.findOneAndUpdate(
                { walletAddress: user.wallet, sessionId },
                {
                  $push: {
                    messages: {
                      role: 'assistant',
                      content: errorMessage,
                      chain: 'base', // Default chain since we don't know which one they want
                      timestamp: new Date(),
                    },
                  },
                },
                { upsert: true },
              );
              await twitterClient.v2.reply(errorMessage, tweet.id);
              return null;
            }

            // If multiple networks are mentioned, use the first one
            if (
              tweet.text.match(/on\s+(arbitrum|base).*on\s+(arbitrum|base)/i)
            ) {
              const message = `Multiple networks detected. Using ${requestedChain} for this request.`;
              // Get the latest session or create a new one
              const latestChat = await this.chatModel
                .findOne({ walletAddress: user.wallet })
                .sort({ createdAt: -1 });
              const sessionId = latestChat?.sessionId || uuidv4();

              // Save the message to chat history
              await this.chatModel.findOneAndUpdate(
                { walletAddress: user.wallet, sessionId },
                {
                  $push: {
                    messages: {
                      role: 'assistant',
                      content: message,
                      chain: requestedChain,
                      timestamp: new Date(),
                    },
                  },
                },
                { upsert: true },
              );
              await twitterClient.v2.reply(message, tweet.id);
            }

            const chain = requestedChain;

            // Check if user has approved this chain
            if (!user.approvedChains?.includes(chain)) {
              const errorMessage = `Please approve the ${chain} network first before using it.`;
              // Get the latest session or create a new one
              const latestChat = await this.chatModel
                .findOne({ walletAddress: user.wallet })
                .sort({ createdAt: -1 });
              const sessionId = latestChat?.sessionId || uuidv4();

              // Save the error message to chat history
              await this.chatModel.findOneAndUpdate(
                { walletAddress: user.wallet, sessionId },
                {
                  $push: {
                    messages: {
                      role: 'assistant',
                      content: errorMessage,
                      chain,
                      timestamp: new Date(),
                    },
                  },
                },
                { upsert: true },
              );
              await twitterClient.v2.reply(errorMessage, tweet.id);
              return null;
            }

            const walletAddress = user.wallet;

            // Get the latest session or create a new one
            const latestChat = await this.chatModel
              .findOne({ walletAddress })
              .sort({ createdAt: -1 });

            const sessionId = latestChat?.sessionId || uuidv4();

            // Format chat history if it exists
            let contextualPrompt = tweet.text;
            if (latestChat && latestChat.messages.length > 0) {
              const MAX_PREVIOUS_MESSAGES = 5;
              const recentMessages = latestChat.messages
                .slice(-MAX_PREVIOUS_MESSAGES)
                .map(
                  (msg) =>
                    `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`,
                )
                .join('\n');

              contextualPrompt = `Previous conversation:\n${recentMessages}\n\nNew message: ${tweet.text}`;
            }

            // Save the user's message
            await this.chatModel.findOneAndUpdate(
              { walletAddress, sessionId },
              {
                $push: {
                  messages: {
                    role: 'user',
                    content: tweet.text,
                    chain,
                    timestamp: new Date(),
                  },
                },
              },
              { upsert: true },
            );

            const apiKey = this.configService.get<string>(
              'CROSSMINT_SERVER_API_KEY',
            );
            const walletSignerSecretKey = this.configService.get<string>(
              'WALLET_SIGNER_SECRET_KEY',
            );
            const chainConfig = this.chainConfigMap[chain];
            const alchemyApiKey = chainConfig.rpcUrl;

            if (
              !apiKey ||
              !walletSignerSecretKey ||
              !alchemyApiKey ||
              !walletAddress
            ) {
              throw new Error('Missing required environment variables');
            }

            const { evmSmartWallet } = crossmint(apiKey);

            const tools = await getOnChainTools({
              wallet: await evmSmartWallet({
                address: walletAddress,
                signer: {
                  secretKey: walletSignerSecretKey as `0x${string}`,
                },
                chain: chain as SmartWalletChainType,
                provider: alchemyApiKey,
              }),
              plugins: [
                tokenInfo({
                  coingeckoApiKey:
                    this.configService.get<string>('COINGECKO_API_KEY'),
                }),
                erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
                zeroEx({
                  apiKey: this.configService.get<string>('ZEROX_API_KEY'),
                }),
                tipping(
                  this.userModel,
                  this.pendingTipModel,
                  this.configService.get<string>('RPC_URL'),
                  this.configService.get<string>(
                    'SAFE_WALLET_SIGNER_PRIVATE_KEY',
                  ),
                ),
              ],
            });

            const result = await generateText({
              model: openai('gpt-4o'),
              tools: tools,
              system:
                'Your name is Midas, named after the fabled King whose touch turned things to gold. As an agent, you are the best DeFi assistant there is who can do all types of DeFi actions like swapping, staking, voting, etc. When you are asked to do any action, search the tools for the description which matches the action you are asked to do. If you find a match, use the tool to perform the action. Also, if a tool mentions to not call or call another tool in its description, make sure you follow the instructions. Be extremely, extremely careful with base units of each token, convert each token into its base units before performing swapping and other stuff. Send the replies concisely, under 280 characters as you are replying on X',
              maxSteps: 12,
              prompt: contextualPrompt,
              onStepFinish: (event) => {
                console.log(event.toolResults);
              },
            });

            // Post reply to the tweet
            try {
              // Format the response to fit Twitter's character limit
              const formattedResponse = this.formatTwitterResponse(result.text);

              // Post the reply
              const reply = await twitterClient.v2.reply(
                formattedResponse,
                tweet.id,
              );

              console.log(`Posted reply to tweet ${tweet.id}:`, reply.data);

              // Only save the assistant's response after successful Twitter reply
              await this.chatModel.findOneAndUpdate(
                { walletAddress, sessionId },
                {
                  $push: {
                    messages: {
                      role: 'assistant',
                      content: result.text,
                      chain,
                      timestamp: new Date(),
                    },
                  },
                },
              );

              return {
                tweetId: tweet.id,
                authorId: tweet.authorId,
                response: result.text,
                replyId: reply.data.id,
                sessionId,
                walletAddress,
              };
            } catch (replyError) {
              console.error(
                `Error posting reply to tweet ${tweet.id}:`,
                replyError,
              );
              // Return the result without saving to chat history if reply fails
              return {
                tweetId: tweet.id,
                authorId: tweet.authorId,
                response: result.text,
                replyError: replyError.message,
                sessionId,
                walletAddress,
              };
            }
          } catch (error) {
            console.error(`Error processing tweet ${tweet.id}:`, error);
            return null;
          }
        }),
      );

      // Filter out failed processing attempts
      const successfulResults = results.filter((result) => result !== null);

      return {
        processed: successfulResults.length,
        total: tweets.length,
        results: successfulResults,
      };
    } catch (error) {
      console.error('Error in callAgentTwitter:', error);
      throw new HttpException(
        error.message || 'Failed to process agent request',
        error.response?.status || 500,
      );
    }
  }

  private formatTwitterResponse(text: string): string {
    // Remove markdown formatting
    let formatted = text.replace(/[*_`#]/g, '');

    // If response is too long, truncate it
    const MAX_LENGTH = 280;
    if (formatted.length > MAX_LENGTH) {
      formatted = formatted.substring(0, MAX_LENGTH - 3) + '...';
    }

    return formatted;
  }

  async connectFarcasterUser(
    crossmintId: string,
    farcasterConnectionDto: FarcasterConnectionDto,
  ) {
    try {
      console.log('\n=== Connecting Farcaster User ===');
      console.log('Timestamp:', new Date().toISOString());
      console.log('Crossmint ID:', crossmintId);
      console.log('Farcaster Details:', {
        fid: farcasterConnectionDto.farcasterFid,
        signerUuid: farcasterConnectionDto.farcasterSignerUuid,
        ethAddress: farcasterConnectionDto.farcasterEthAddress,
      });

      // Find the user by crossmintId
      console.log('\nLooking up user by Crossmint ID...');
      const user = await this.userModel.findOne({ crossmintId });
      if (!user) {
        console.error('User not found with Crossmint ID:', crossmintId);
        throw new HttpException('User not found', 404);
      }
      console.log('User found:', {
        crossmintId: user.crossmintId,
        existingFarcasterFid: user.farcasterFid,
        existingFarcasterEthAddress: user.farcasterEthAddress,
      });

      // Update user with Farcaster details
      console.log('\nUpdating user with Farcaster details...');
      const updatedUser = await this.userModel.findOneAndUpdate(
        { crossmintId },
        {
          farcasterFid: farcasterConnectionDto.farcasterFid,
          farcasterSignerUuid: farcasterConnectionDto.farcasterSignerUuid,
          farcasterEthAddress: farcasterConnectionDto.farcasterEthAddress,
        },
        { new: true },
      );

      console.log('User updated successfully:', {
        crossmintId: updatedUser.crossmintId,
        farcasterFid: updatedUser.farcasterFid,
        farcasterEthAddress: updatedUser.farcasterEthAddress,
      });

      return {
        message: 'Farcaster connection successful',
        user: {
          crossmintId: updatedUser.crossmintId,
          farcasterFid: updatedUser.farcasterFid,
          farcasterEthAddress: updatedUser.farcasterEthAddress,
        },
      };
    } catch (error) {
      console.error('\n=== Error in connectFarcasterUser ===');
      console.error('Error details:', {
        message: error.message,
        status: error.status,
        timestamp: new Date().toISOString(),
      });
      throw new HttpException(
        error.message || 'Failed to connect Farcaster user',
        error.status || 500,
      );
    }
  }

  async getFarcasterConnection(crossmintId: string) {
    try {
      console.log('\n=== Fetching Farcaster Connection Details ===');
      console.log('Crossmint ID:', crossmintId);

      // Find the user by crossmintId
      const user = await this.userModel.findOne({ crossmintId });
      if (!user) {
        console.error('User not found with Crossmint ID:', crossmintId);
        throw new HttpException('User not found', 404);
      }

      // Check if user has Farcaster details
      const hasFarcasterConnection = Boolean(
        user.farcasterFid && user.farcasterEthAddress,
      );

      console.log('User Farcaster status:', {
        hasConnection: hasFarcasterConnection,
        farcasterFid: user.farcasterFid,
        farcasterEthAddress: user.farcasterEthAddress,
      });

      return {
        hasFarcasterConnection,
        farcasterDetails: hasFarcasterConnection
          ? {
              farcasterFid: user.farcasterFid,
              farcasterEthAddress: user.farcasterEthAddress,
            }
          : null,
      };
    } catch (error) {
      console.error('Error fetching Farcaster connection:', error);
      throw new HttpException(
        error.message || 'Failed to fetch Farcaster connection',
        error.status || 500,
      );
    }
  }

  async getUser(identifier: { wallet?: string; crossmintId?: string }) {
    try {
      console.log('\n=== Fetching User Details ===');
      console.log('Identifier:', identifier);

      if (!identifier.wallet && !identifier.crossmintId) {
        throw new HttpException(
          'Either wallet or crossmintId must be provided',
          400,
        );
      }

      // Build query based on provided identifier
      const query = identifier.wallet
        ? { wallet: identifier.wallet }
        : { crossmintId: identifier.crossmintId };

      const user = await this.userModel.findOne(query);

      // Return standardized response whether user exists or not
      return {
        exists: !!user,
        user: user
          ? {
              crossmintId: user.crossmintId,
              wallet: user.wallet,
              twitterId: user.twitterId,
              twitterUsername: user.twitterUsername,
              approvedChains: user.approvedChains,
              farcasterFid: user.farcasterFid,
              farcasterEthAddress: user.farcasterEthAddress,
            }
          : null,
      };
    } catch (error) {
      console.error('Error fetching user:', error);
      throw new HttpException(
        error.message || 'Failed to fetch user details',
        error.status || 500,
      );
    }
  }
}
