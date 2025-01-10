import { WebAuthnP256 } from 'ox';

export class ApproveDelegateDto {
  walletLocator: string;
  signatureId: string;
  signer: string;
  signingResult: WebAuthnP256.sign.ReturnType;
}
