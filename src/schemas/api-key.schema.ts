import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ApiKey extends Document {
  @Prop({ required: true })
  walletAddress: string;

  @Prop({ required: true })
  encryptedKey: string;
}

export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
