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
// import { modeVoting } from '../workspace/goat-sdk/plugins/mode-voting/src';
// import { kim } from '../workspace/goat-sdk/plugins/kim/src';
import { ironclad } from '../workspace/goat-sdk/plugins/ironclad/src';
// import { sendETH } from '@goat-sdk/wallet-evm';
import { tokenInfo } from '../workspace/goat-sdk/plugins/token-info/src';
// import { merchantMoe } from '../workspace/goat-sdk/plugins/merchant-moe/src';
import { zeroEx } from '../workspace/goat-sdk/plugins/0x/src';
import { odos } from '../workspace/goat-sdk/plugins/Odos/src';
import { openai } from '@ai-sdk/openai';
import { ChainType, SmartWalletChainType } from './dto/agent-call.dto';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Chat } from './schemas/chat.schema';
import { v4 as uuidv4 } from 'uuid';
import { createCipheriv, randomBytes, createHash } from 'crypto';
import { ApiKey } from './schemas/api-key.schema';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mantle, mode, base } from 'viem/chains';
import { viem } from '@goat-sdk/wallet-viem';
import { networkTools } from './config/network-tools.config';
import { isSmartWalletChain } from './config/chains.config';
import { SupportedChainType } from './config/chains.config';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    @InjectModel(ApiKey.name) private apiKeyModel: Model<ApiKey>,
    private configService: ConfigService,
  ) {}

  private readonly ENCRYPTION_KEY =
    this.configService.get<string>('ENCRYPTION_KEY');

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
          chain: chain,
          provider: alchemyApiKey,
        }),
        plugins: [
          tokenInfo({
            coingeckoApiKey:
              this.configService.get<string>('COINGECKO_API_KEY'),
          }),
          erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
          odos(),
          zeroEx({
            apiKey: this.configService.get<string>('0X_API_KEY'),
          }),
          ironclad(),
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

      if (!isSmartWalletChain(chain as ChainType)) {
        throw new HttpException(
          'This chain does not support smart wallet operations',
          400,
        );
      }

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
      const alchemyApiKey = this.configService.get<string>(
        'ALCHEMY_API_KEY_MODE',
      );

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
          chain: chain,
          provider: alchemyApiKey,
        }),
        plugins: [
          tokenInfo({
            coingeckoApiKey:
              this.configService.get<string>('COINGECKO_API_KEY'),
          }),
          odos(),
          zeroEx({
            apiKey: this.configService.get<string>('0X_API_KEY'),
          }),
          erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
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
      console.error('Error in callAgentPublic:', error);
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
    mantle: {
      rpcUrl: process.env.ALCHEMY_API_KEY_MANTLE,
      chain: mantle,
    },
    mode: {
      rpcUrl: process.env.ALCHEMY_API_KEY_MODE,
      chain: mode,
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
        throw new Error(`Unsupported chain: ${chain}`);
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
          odos(),
          zeroEx({
            apiKey: this.configService.get<string>('0X_API_KEY'),
          }),
          erc20({ tokens: [USDC, USDT, MODE, WETH, ezETH, wrsETH] }),
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
        throw new HttpException(
          error.message || 'Failed to process agent request',
          error.response?.status || 500,
        );
      }
    } catch (error) {
      console.error('Error in callAgentViem:', error);
      throw new HttpException(
        error.message || 'Failed to process agent request',
        error.response?.status || 500,
      );
    }
  }
}
