import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class Message {
  @Prop({ required: true })
  role: 'user' | 'assistant';

  @Prop({ required: true })
  content: string;

  @Prop({ required: true })
  chain: string;

  @Prop()
  timestamp: Date;
}

@Schema({ timestamps: true })
export class Chat extends Document {
  @Prop({ required: true, index: true })
  walletAddress: string;

  @Prop({ required: true })
  sessionId: string;

  @Prop({
    type: [{ role: String, content: String, chain: String, timestamp: Date }],
  })
  messages: Message[];
}

export const ChatSchema = SchemaFactory.createForClass(Chat);
