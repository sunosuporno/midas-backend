import { Controller, Get, Post, Body, Param } from '@nestjs/common';
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

  @Post('wallets/:walletLocator/delegated-key')
  createDelegatedKey(
    @Param('walletLocator') walletLocator: string,
    @Body() createDelegatedKeyDto: CreateDelegatedKeyDto,
  ) {
    return this.appService.approveDelegatedKey(
      walletLocator,
      createDelegatedKeyDto,
    );
  }

  @Post('wallet/create')
  createWallet(@Body() createWalletDto: CreateWalletDto) {
    return this.appService.createWallet(createWalletDto);
  }

  @Post('approve-delegate')
  approveDelegate(@Body() approveDelegateDto: ApproveDelegateDto) {
    return this.appService.approveDelegate(approveDelegateDto);
  }

  @Post('call/agent')
  async callAgent(@Body() agentCallDto: AgentCallDto) {
    return this.appService.callAgent(
      agentCallDto.prompt,
      agentCallDto.walletAddress,
    );
  }
}
