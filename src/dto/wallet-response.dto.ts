interface AdminSigner {
  type: string;
  address: string;
  locator: string;
}

interface WalletConfig {
  adminSigner: AdminSigner;
}

export interface WalletResponse {
  type: string;
  linkedUser: string;
  address: string;
  config: WalletConfig;
}
