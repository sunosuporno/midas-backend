import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
} from '@nestjs/common';
import { AppService } from './app.service';
import { CreateDelegatedKeyDto } from './dto/create-delegated-key.dto';
// import { CreateWalletDto } from './dto/create-wallet.dto';
import { ApproveDelegateDto } from './dto/approve-delegate.dto';
import { AgentCallDto } from './dto/agent-call.dto';
import { SaveMessageDto } from './dto/save-message.dto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

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
}
