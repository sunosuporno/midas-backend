import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  UseGuards,
  Headers,
  Query,
} from '@nestjs/common';
import { AppService } from './app.service';
import { CreateDelegatedKeyDto } from './dto/create-delegated-key.dto';
// import { CreateWalletDto } from './dto/create-wallet.dto';
import { ApproveDelegateDto } from './dto/approve-delegate.dto';
import { AgentCallDto, AgentCallViemDto } from './dto/agent-call.dto';
import { SaveMessageDto } from './dto/save-message.dto';
import { CrossmintJwtGuard } from './guards/jwt.guard';
import { Public } from './decorators/public.decorator';
import { FarcasterConnectionDto } from './dto/farcaster-connection.dto';

export class AgentViemCallDto {
  prompt: string;
  chain: string;
  privateKey: string;
}

@UseGuards(CrossmintJwtGuard)
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('check-delegated/:walletaddress')
  async checkDelegated(@Param('walletaddress') walletAddress: string) {
    try {
      return await this.appService.checkDelegated(walletAddress);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('wallets/:walletLocator/delegated-key')
  async createDelegatedKey(
    @Param('walletLocator') walletLocator: string,
    @Body() createDelegatedKeyDto: CreateDelegatedKeyDto,
  ) {
    try {
      return await this.appService.createDelegatedKey(
        walletLocator,
        createDelegatedKeyDto,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  // @Post('wallet/create')
  // async createWallet(@Body() createWalletDto: CreateWalletDto) {
  //   try {
  //     return await this.appService.createWallet(createWalletDto);
  //   } catch (error) {
  //     throw new HttpException(error.message, error.status || 500);
  //   }
  // }

  @Post('approve-delegate')
  async approveDelegate(@Body() approveDelegateDto: ApproveDelegateDto) {
    try {
      return await this.appService.approveDelegate(approveDelegateDto);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('chat/session')
  async createChatSession(
    @Body() body: { walletAddress: string; chain: string },
  ) {
    try {
      return await this.appService.createChatSession(body.walletAddress);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('chat/sessions/:walletAddress')
  async getChatSessions(@Param('walletAddress') walletAddress: string) {
    try {
      return await this.appService.getChatSessions(walletAddress);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('chat/:walletAddress/:sessionId')
  async getChatHistory(
    @Param('walletAddress') walletAddress: string,
    @Param('sessionId') sessionId: string,
  ) {
    try {
      return await this.appService.getChatHistory(walletAddress, sessionId);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('call/agent')
  async callAgent(@Body() agentCallDto: AgentCallDto) {
    try {
      return await this.appService.callAgent(
        agentCallDto.prompt,
        agentCallDto.walletAddress,
        agentCallDto.chain,
        agentCallDto.sessionId,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('chat/:walletAddress/:sessionId/message')
  async saveUserMessage(
    @Param('walletAddress') walletAddress: string,
    @Param('sessionId') sessionId: string,
    @Body() message: SaveMessageDto,
  ) {
    try {
      return await this.appService.saveUserMessage(
        walletAddress,
        sessionId,
        message,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('generate-api-key')
  async generateApiKey(@Body() body: { walletAddress: string }) {
    try {
      return await this.appService.generateApiKey(body.walletAddress);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Public()
  @Post('call/agent/public')
  async callAgentPublic(
    @Headers('x-api-key') apiKey: string,
    @Body() agentCallDto: AgentCallDto,
  ) {
    try {
      const walletAddress = await this.appService.validateApiKey(apiKey);
      console.log('Using wallet address:', walletAddress);
      return await this.appService.callAgentPublic(
        agentCallDto.prompt,
        walletAddress,
        agentCallDto.chain,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Public()
  @Post('call/agent/viem')
  async callAgentViem(@Body() agentCallViemDto: AgentCallViemDto) {
    try {
      return await this.appService.callAgentViem(
        agentCallViemDto.prompt,
        agentCallViemDto.chain,
        agentCallViemDto.privateKey,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('users/:crossmintId/farcaster')
  async connectFarcasterUser(
    @Param('crossmintId') crossmintId: string,
    @Body() farcasterConnectionDto: FarcasterConnectionDto,
  ) {
    console.log('\n=== Farcaster Connection Request Received ===');
    console.log('Crossmint ID from params:', crossmintId);
    console.log('Request body:', farcasterConnectionDto);

    try {
      const result = await this.appService.connectFarcasterUser(
        crossmintId,
        farcasterConnectionDto,
      );
      console.log('Farcaster connection successful:', result);
      return result;
    } catch (error) {
      console.error('Error in controller:', error);
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('users/:crossmintId/farcaster')
  async getFarcasterConnection(@Param('crossmintId') crossmintId: string) {
    console.log('\n=== Fetching Farcaster Connection Details ===');
    console.log('Crossmint ID:', crossmintId);

    try {
      const result = await this.appService.getFarcasterConnection(crossmintId);
      console.log('Farcaster details retrieved:', result);
      return result;
    } catch (error) {
      console.error('Error fetching Farcaster details:', error);
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('users')
  async getUser(
    @Query('wallet') wallet?: string,
    @Query('crossmintId') crossmintId?: string,
  ) {
    console.log('\n=== User Details Request Received ===');
    console.log('Query params:', { wallet, crossmintId });

    try {
      const result = await this.appService.getUser({ wallet, crossmintId });
      console.log('User details retrieved:', result);
      return result;
    } catch (error) {
      console.error('Error in controller:', error);
      throw new HttpException(error.message, error.status || 500);
    }
  }
}
