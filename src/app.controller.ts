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
import { CreateWalletDto } from './dto/create-wallet.dto';
import { ApproveDelegateDto } from './dto/approve-delegate.dto';
import { AgentCallDto } from './dto/agent-call.dto';

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
      return await this.appService.approveDelegatedKey(
        walletLocator,
        createDelegatedKeyDto,
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('wallet/create')
  async createWallet(@Body() createWalletDto: CreateWalletDto) {
    try {
      return await this.appService.createWallet(createWalletDto);
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Post('approve-delegate')
  async approveDelegate(@Body() approveDelegateDto: ApproveDelegateDto) {
    try {
      return await this.appService.approveDelegate(approveDelegateDto);
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
      );
    } catch (error) {
      throw new HttpException(error.message, error.status || 500);
    }
  }
}
