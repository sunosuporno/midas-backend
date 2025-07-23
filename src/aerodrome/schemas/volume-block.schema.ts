import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VolumeBlockDocument = VolumeBlock & Document;

@Schema({ timestamps: true })
export class VolumeBlock {
  @Prop({ required: true, default: 'weth-usdc' })
  poolAddress: string;

  @Prop({ required: true })
  period: 'morning' | 'afternoon' | 'night'; // 8am-4pm, 4pm-12am, 12am-8am GMT+5.30

  @Prop({ required: true, default: 0 })
  wethVolume: number; // WETH volume moving average (7-day average)

  @Prop({ required: true, default: 0 })
  usdcVolume: number; // USDC volume moving average (7-day average)

  @Prop({ required: true, default: 0 })
  swapsCount: number; // Swaps count moving average (7-day average)

  @Prop({ required: true, default: 0 })
  averageTick: number; // Average tick moving average (7-day average)

  @Prop({ type: [Object], default: [] })
  volumeHistory: Array<{
    blockStart: number;
    blockEnd: number;
    blockStartTime: string; // Human readable timestamp
    blockEndTime: string; // Human readable timestamp
    wethVolume: number;
    usdcVolume: number;
    swapsCount: number;
    averageTick: number;
    period: 'morning' | 'afternoon' | 'night';
    createdAt: Date;
  }>; // Keep last 7 entries (7 days for this period)

  @Prop()
  lastUpdated: Date;
}

export const VolumeBlockSchema = SchemaFactory.createForClass(VolumeBlock);

// Index for efficient queries
VolumeBlockSchema.index({ poolAddress: 1, period: 1 }, { unique: true });
