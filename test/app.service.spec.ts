import { Test, TestingModule } from '@nestjs/testing';
import { AppService } from '../src/app.service';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Chat } from '../src/schemas/chat.schema';
import { Model } from 'mongoose';
import axios from 'axios';
import { HttpException } from '@nestjs/common';
import { ChainType } from '../src/dto/agent-call.dto';

jest.mock('axios');
jest.mock('uuid', () => ({ v4: () => 'mock-uuid' }));
jest.mock('ai', () => ({
  generateText: jest.fn().mockResolvedValue({ text: 'AI response' }),
}));

describe('AppService', () => {
  let service: AppService;
  let configService: ConfigService;
  let chatModel: Model<Chat>;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config = {
        CROSSMINT_SERVER_API_KEY: 'mock-api-key',
        SIGNER_WALLET: 'evm-keypair:0xmockAddress',
        WALLET_SIGNER_SECRET_KEY: 'mock-secret-key',
        ALCHEMY_API_KEY_MODE: 'mock-alchemy-key',
      };
      return config[key];
    }),
  };

  const mockChatModel = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: getModelToken(Chat.name),
          useValue: mockChatModel,
        },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
    configService = module.get<ConfigService>(ConfigService);
    chatModel = module.get<Model<Chat>>(getModelToken(Chat.name));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getHello', () => {
    it('should return "gm world!"', () => {
      expect(service.getHello()).toBe('gm world!');
    });
  });

  describe('createDelegatedKey', () => {
    const mockWalletLocator = '0xmockWallet';
    const mockCreateDelegatedKeyDto = {
      chain: 'ethereum-sepolia',
      expiresAt: '1234567890',
    };

    it('should successfully create a delegated key', async () => {
      const mockResponse = {
        data: {
          chains: {
            'ethereum-sepolia': {
              id: 'mock-auth-id',
              approvals: {
                pending: [
                  {
                    message: 'mock-message',
                    signer: 'mock-signer',
                  },
                ],
              },
            },
          },
        },
      };

      (axios.post as jest.Mock).mockResolvedValueOnce(mockResponse);

      const result = await service.createDelegatedKey(
        mockWalletLocator,
        mockCreateDelegatedKeyDto,
      );

      expect(result).toEqual({
        messageToSign: 'mock-message',
        signer: 'mock-signer',
        authorizationId: 'mock-auth-id',
      });
    });

    it('should throw error for invalid expiresAt timestamp', async () => {
      await expect(
        service.createDelegatedKey(mockWalletLocator, {
          ...mockCreateDelegatedKeyDto,
          expiresAt: 'invalid',
        }),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('Chat Sessions', () => {
    const mockWalletAddress = '0xmockWallet';
    const mockSessionId = 'mock-uuid';

    it('should create a new chat session', async () => {
      const mockChat = {
        walletAddress: mockWalletAddress,
        sessionId: mockSessionId,
        messages: [],
        save: jest.fn().mockResolvedValueOnce(true),
      };

      jest
        .spyOn(mockChatModel.prototype, 'save')
        .mockImplementationOnce(() => Promise.resolve(mockChat));

      const result = await service.createChatSession(mockWalletAddress);

      expect(result).toEqual({ sessionId: mockSessionId });
    });

    it('should get chat sessions for a wallet', async () => {
      const mockSessions = [
        { sessionId: 'session1', createdAt: new Date() },
        { sessionId: 'session2', createdAt: new Date() },
      ];

      mockChatModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          sort: jest.fn().mockResolvedValue(mockSessions),
        }),
      });

      const result = await service.getChatSessions(mockWalletAddress);

      expect(result).toEqual(mockSessions);
    });

    it('should save user message', async () => {
      const mockMessage = {
        content: 'Hello',
        chain: ChainType.MODE_TESTNET,
      };

      mockChatModel.findOneAndUpdate.mockResolvedValueOnce({
        walletAddress: mockWalletAddress,
        sessionId: mockSessionId,
        messages: [mockMessage],
      });

      await service.saveUserMessage(
        mockWalletAddress,
        mockSessionId,
        mockMessage,
      );

      expect(mockChatModel.findOneAndUpdate).toHaveBeenCalled();
    });
  });

  describe('callAgent', () => {
    const mockWalletAddress = '0xmockWallet';
    const mockPrompt = 'Hello AI';
    const mockChain = ChainType.MODE_TESTNET;
    const mockSessionId = 'mock-session-id';

    it('should successfully call agent and save response', async () => {
      mockChatModel.findOneAndUpdate.mockResolvedValueOnce({
        acknowledged: true,
      });

      const result = await service.callAgent(
        mockPrompt,
        mockWalletAddress,
        mockChain,
        mockSessionId,
      );

      expect(result).toEqual({ response: 'AI response' });
      expect(mockChatModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it('should throw error when required env variables are missing', async () => {
      jest.spyOn(configService, 'get').mockReturnValue(null);

      await expect(
        service.callAgent(mockPrompt, mockWalletAddress, mockChain),
      ).rejects.toThrow('Missing required environment variables');
    });
  });

  describe('checkDelegated', () => {
    const mockWalletAddress = '0xmockWallet';

    it('should return delegation status when delegated', async () => {
      const mockResponse = {
        data: {
          type: 'evm-keypair',
          address: '0xmockAddress',
          chains: {},
        },
      };

      (axios.get as jest.Mock).mockResolvedValueOnce(mockResponse);

      const result = await service.checkDelegated(mockWalletAddress);

      expect(result).toEqual(mockResponse.data);
    });

    it('should return standardized response when not delegated', async () => {
      (axios.get as jest.Mock).mockRejectedValueOnce({
        response: { status: 404 },
      });

      const result = await service.checkDelegated(mockWalletAddress);

      expect(result).toEqual({
        type: 'evm-keypair',
        address: '0xmockAddress',
        locator: 'evm-keypair:0xmockAddress',
        expiresAt: '0',
        chains: {},
      });
    });
  });
});
