import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class User extends Document {
  @Prop({ required: true, unique: true })
  crossmintId: string;

  @Prop()
  twitterId?: string;

  @Prop()
  wallet?: string;

  @Prop({ type: [String], default: [] })
  approvedChains: string[];
}

export const UserSchema = SchemaFactory.createForClass(User);
