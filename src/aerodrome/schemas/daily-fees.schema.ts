import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DailyFeesDocument = DailyFees & Document;

@Schema({ timestamps: true })
export class DailyFees {
  @Prop({ required: true, unique: true })
  date: string; // Format: YYYY-MM-DD (UTC)

  @Prop({ required: true, default: 0 })
  totalUsdValue: number; // Total USD value of fees collected on this day

  @Prop({ type: Object, default: {} })
  positionFees: {
    [positionId: string]: {
      token0: string; // Raw amount collected for token0
      token1: string; // Raw amount collected for token1
      usdValue: number; // USD value of fees for this position
      walletLocator: string; // Wallet that owns this position
      pool: string; // Pool address
      timestamp: Date; // When fees were collected
    };
  };

  @Prop({ type: Object, default: {} })
  tokenTotals: {
    [tokenAddress: string]: {
      symbol: string;
      amount: string; // Raw amount collected across all positions
      usdValue: number; // USD value of this token's fees
    };
  };

  @Prop({ default: 0 })
  totalPositions: number; // Number of positions that earned fees on this day

  @Prop({ default: 0 })
  totalCollections: number; // Number of fee collection transactions on this day
}

export const DailyFeesSchema = SchemaFactory.createForClass(DailyFees);
