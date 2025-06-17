import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class PendingTip extends Document {
  @Prop({ required: true })
  xHandle: string;

  @Prop({ required: true })
  tokenAddress: string;

  @Prop({ required: true })
  amount: string;

  @Prop({ required: true })
  transactionHash: string;

  @Prop({ required: true })
  chainId: string;

  @Prop({ default: false })
  claimed: boolean;

  @Prop()
  claimedAt?: Date;
}

export const PendingTipSchema = SchemaFactory.createForClass(PendingTip);
