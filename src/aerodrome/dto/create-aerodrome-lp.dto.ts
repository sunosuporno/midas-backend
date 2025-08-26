import {
  IsString,
  IsNumber,
  IsPositive,
  IsNotEmpty,
  IsOptional,
  Min,
  Max,
  IsBoolean,
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

  @IsOptional()
  @IsBoolean()
  isRebalanceOrRetry?: boolean; // Flag to indicate if this is a retry or rebalance operation

  @IsOptional()
  @IsString()
  positionId?: string; // Position ID for retry operations to get stored token amounts

  strategyName?: string; // Optional, e.g., 'fee-optimiser'

  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(10)
  rebalanceRange?: number; // Optional rebalance range for fee-optimiser strategy (default: 3.0)

  @IsOptional()
  @IsNumber()
  customTickLower?: number; // Optional custom tick lower for optimal rebalancing

  @IsOptional()
  @IsNumber()
  customTickUpper?: number; // Optional custom tick upper for optimal rebalancing

  @IsOptional()
  @IsNumber()
  assumedCurrentTick?: number; // Optional assumed current tick for rebalancing (overrides on-chain slot0)
}
