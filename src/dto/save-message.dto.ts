import { IsNotEmpty, IsString } from 'class-validator';
import { ChainType } from './agent-call.dto';

export class SaveMessageDto {
  @IsNotEmpty()
  @IsString()
  content: string;

  @IsNotEmpty()
  chain: ChainType;
}
