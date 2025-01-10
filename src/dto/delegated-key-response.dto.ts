interface Approval {
  signer: string;
  message: string;
}

interface ChainAuthorization {
  id: string;
  status: string;
  approvals: {
    submitted: any[];
    pending: Approval[];
  };
}

export interface DelegatedKeyResponse {
  type: string;
  address: string;
  locator: string;
  expiresAt: string;
  chains: {
    [chain: string]: ChainAuthorization;
  };
}

export interface SimplifiedDelegatedKeyResponse {
  messageToSign: string;
  authorizationId: string;
}
