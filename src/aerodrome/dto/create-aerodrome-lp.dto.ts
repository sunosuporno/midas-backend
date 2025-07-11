import {
  IsString,
  IsNumber,
  IsPositive,
  IsNotEmpty,
  IsOptional,
  Min,
  Max,
} from 'class-validator';

export class CreateAerodromeLpDto {
  @IsString()
  @IsNotEmpty()
  walletLocator: string;

  @IsNumber()
  @IsPositive()
  usdcAmount: number;

  @IsString()
  @IsNotEmpty()
  pool: string; // Format: 'eth-usdc' or 'usdc-usd+'

  @IsOptional()
  @IsString()
  description?: string; // Optional description for the position

  @IsOptional()
  @IsString()
  rebalancedPositionId?: string; // Optional ID of the position being rebalanced

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  percentDeviation?: number; // Optional percent deviation for tick range (default: 1.5)
}
