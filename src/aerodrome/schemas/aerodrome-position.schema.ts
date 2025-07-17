import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AerodromePositionDocument = AerodromePosition & Document;

@Schema({ timestamps: true })
export class AerodromePosition {
  @Prop({ required: true })
  walletLocator: string;

  @Prop({ required: true })
  pool: string;

  @Prop({ required: true })
  usdcAmount: number;

  @Prop({ required: true })
  positionId: string;

  @Prop({ required: true, default: 'pending' })
  status:
    | 'pending'
    | 'active'
    | 'failed'
    | 'rebalancing'
    | 'mint_failed'
    | 'cleanup_completed'
    | 'cleanup_failed'
    | 'retry_successful'
    | 'retry_failed';

  @Prop()
  transactionHash?: string;

  @Prop()
  lpTokens?: number;

  @Prop({ type: Object })
  metadata?: Record<string, any>; // mintDetails now includes token0PriceAtMint and token1PriceAtMint

  @Prop({ type: Object, default: { token0: '0', token1: '0' } })
  collectedFees?: {
    token0: string;
    token1: string;
  };

  // New fields for retry/rebalancing system
  @Prop({ type: Object })
  retryMetadata?: {
    originalTokenAmounts?: {
      token0: string;
      token1: string;
      totalUSDValue: number;
    };
    currentTokenAmounts?: {
      token0: string;
      token1: string;
      totalUSDValue: number;
    };
    retryAttempts?: number;
    lastRetryAt?: Date;
    rebalancingSwaps?: Array<{
      fromToken: string;
      toToken: string;
      amount: string;
      transactionHash: string;
      timestamp: Date;
    }>;
  };

  // Wallet-level rebalancing queue system
  @Prop({ type: Object })
  walletRebalancingQueue?: {
    isRebalancing: boolean;
    currentPositionId: string;
    queuedPositions: string[]; // Array of position IDs waiting
    startedAt: Date;
    currentReason: string;
  };
}

export const AerodromePositionSchema =
  SchemaFactory.createForClass(AerodromePosition);
