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
  erc20,
  MODE,
} from '../workspace/goat-sdk/plugins/erc20/src';
import { modeVoting } from '../workspace/goat-sdk/plugins/mode-voting/src';
import { kim } from '../workspace/goat-sdk/plugins/kim/src';
import { ironclad } from '../workspace/goat-sdk/plugins/ironclad/src';
import { sendETH } from '@goat-sdk/wallet-evm';
import { openai } from '@ai-sdk/openai';
import { ChainType } from './dto/agent-call.dto';
import { Model } from 'mongoose';
import { InjectModel } from '@nestjs/mongoose';
import { Chat } from './schemas/chat.schema';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(Chat.name) private chatModel: Model<Chat>,
    private configService: ConfigService,
  ) {}

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
    return this.chatModel
      .find({ walletAddress })
      .select('sessionId createdAt')
      .sort({ createdAt: -1 });
  }

  async getChatHistory(walletAddress: string, sessionId: string) {
    return this.chatModel.findOne({ walletAddress, sessionId });
  }

  async callAgent(
    prompt: string,
    walletAddress: string,
    chain: ChainType,
    sessionId?: string,
  ) {
    try {
      console.log('=== Calling Agent ===');
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

      const { smartwallet } = crossmint(apiKey);

      const tools = await getOnChainTools({
        wallet: await smartwallet({
          address: walletAddress,
          signer: {
            secretKey: walletSignerSecretKey as `0x${string}`,
          },
          chain,
          provider: alchemyApiKey,
        }),
        plugins: [
          sendETH(),
          erc20({ tokens: [USDC, USDT, MODE] }),
          modeVoting(),
          kim(),
          ironclad(),
        ],
      });

      const result = await generateText({
        model: openai('gpt-4o'),
        tools: tools,
        system:
          'You name is Midas, named after the fabled King whose touch turned things to gold. As an agent, you are the best DeFi assistant there is who can do all types of DeFi actions like swapping, staking, voting, etc. When you are asked to do any action, search for the description which matches the action you are asked to do. If you find a match, use the tool to perform the action. Also, if a tool mentions to not call or call another tool in its description, make sure you follow the instructions. Send the data in a plain text format with heading on top and ',
        maxSteps: 12,
        prompt: prompt,
      });

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
      console.error('Error in callAgent:', error);
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
}
