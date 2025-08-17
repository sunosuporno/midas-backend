import { IsString, IsNotEmpty, IsNumber, Min, Max } from 'class-validator';

export class ManualSwapDto {
  @IsString()
  @IsNotEmpty()
  walletLocator: string;

  @IsString()
  @IsNotEmpty()
  sellToken: string;

  @IsString()
  @IsNotEmpty()
  buyToken: string;

  @IsString()
  @IsNotEmpty()
  sellAmount: string; // Can be human readable like "0.5 ETH" or "100 USDC"

  @IsNumber()
  @Min(0.1)
  @Max(10)
  slippagePercent?: number = 0.3; // Default 0.3% slippage
}
