import { IsString, IsNotEmpty } from 'class-validator';

export class FarcasterConnectionDto {
  @IsString()
  @IsNotEmpty()
  farcasterFid: string;

  @IsString()
  @IsNotEmpty()
  farcasterSignerUuid: string;

  @IsString()
  @IsNotEmpty()
  farcasterEthAddress: string;
}
