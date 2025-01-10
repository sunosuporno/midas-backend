import { Injectable, HttpException } from '@nestjs/common';
import { CreateDelegatedKeyDto } from './dto/create-delegated-key.dto';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { parseUnits } from 'viem';
import { tokens } from './config/tokens';
import {
  DelegatedKeyResponse,
  SimplifiedDelegatedKeyResponse,
} from './dto/delegated-key-response.dto';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletResponse } from './dto/wallet-response.dto';
import { ApproveDelegateDto } from './dto/approve-delegate.dto';
import { generateText } from 'ai';
import { getOnChainTools } from '@goat-sdk/adapter-vercel-ai';
import { crossmint } from '@goat-sdk/crossmint';
import { USDC, erc20 } from '@goat-sdk/plugin-erc20';
import { sendETH } from '@goat-sdk/wallet-evm';
import { openai } from '@ai-sdk/openai';

@Injectable()
export class AppService {
  constructor(private configService: ConfigService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async approveDelegatedKey(
    walletLocator: string,
    createDelegatedKeyDto: CreateDelegatedKeyDto,
  ) {
    try {
      console.log('=== Assign Delegate Key Request ===');
      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      const signerWallet = this.configService.get<string>('SIGNER_WALLET');

      const expiresAt = Number(createDelegatedKeyDto.expiresAt);
      if (isNaN(expiresAt)) {
        throw new HttpException('Invalid expiresAt timestamp', 400);
      }

      console.log('chain:', createDelegatedKeyDto.chain);

      // Step 1: Create initial delegated key
      console.log('Step 1: Registering delegated key');
      const initialResponse = await axios.post(
        `https://www.crossmint.com/api/2022-06-09/wallets/${walletLocator}/signers`,
        {
          chain: createDelegatedKeyDto.chain,
          expiresAt: expiresAt,
          signer: signerWallet,
        },
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

      return {
        messageToSign: chainAuth.approvals.pending[0].message,
        signer: chainAuth.approvals.pending[0].signer,
        authorizationId: chainAuth.id,
      };
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

  async createWallet(
    createWalletDto: CreateWalletDto,
  ): Promise<WalletResponse> {
    try {
      console.log('Creating wallet with DTO:', createWalletDto);

      const apiKey = this.configService.get<string>('CROSSMINT_SERVER_API_KEY');
      console.log('Using API key:', apiKey?.substring(0, 10) + '...');

      const { email, signerAddress } = createWalletDto;

      const requestBody = {
        type: 'evm-smart-wallet',
        config: {
          adminSigner: {
            type: 'evm-keypair',
            address: signerAddress,
          },
        },
        linkedUser: `email:${email}`,
      };
      console.log('Request body:', requestBody);

      const response = await axios.post<WalletResponse>(
        'https://www.crossmint.com/api/2022-06-09/wallets',
        requestBody,
        {
          headers: {
            'X-API-KEY': apiKey,
            'x-idempotency-key': email,
            'Content-Type': 'application/json',
          },
        },
      );

      console.log('Crossmint API Response:', response.data);
      return response.data;
    } catch (error) {
      console.error(
        'Error in createWallet:',
        error.response?.data || error.message,
      );
      throw new HttpException(
        error.response?.data?.message || 'Failed to create wallet',
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

  async callAgent(prompt: string, walletAddress: string) {
    try {
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
          chain: 'mode',
          provider: alchemyApiKey,
        }),
        plugins: [sendETH(), erc20({ tokens: [USDC] })],
      });

      const result = await generateText({
        model: openai('gpt-4'),
        tools: tools,
        maxSteps: 12,
        prompt: prompt,
      });

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
