export class CreateDelegatedKeyDto {
  chain: string;
  expiresAt?: string;
  userDetails?: {
    crossmintId: string;
    twitterId?: string;
    twitterUsername?: string;
    wallet?: string;
  };
}
