import Safe from '@safe-global/protocol-kit';
import SafeApiKit from '@safe-global/api-kit';
import { MetaTransactionData, OperationType } from '@safe-global/types-kit';

export class SafeWalletService {
  private safeApiKit: SafeApiKit;
  private safeProtocolKit: Safe;

  // Safe wallet addresses per chain
  private readonly SAFE_WALLETS = {
    '42161': '0x5b8C0B05b204b8DEF9862c9fd63218c624Fd70ED', // Arbitrum safe wallet address
    '8453': '0x5b8C0B05b204b8DEF9862c9fd63218c624Fd70ED', // Base safe wallet address
  } as const;

  constructor(
    private readonly rpcUrl: string,
    private readonly signerPrivateKey: string,
    private readonly signerAddress: string,
  ) {}

  async initializeSafeWallet(chainId: string) {
    console.log('=== Initializing Safe Wallet ===');
    console.log('Chain ID:', chainId);

    // Initialize Safe API Kit
    console.log('Initializing Safe API Kit...');
    this.safeApiKit = new SafeApiKit({
      chainId: BigInt(chainId),
    });
    console.log('Safe API Kit initialized');

    // Initialize Safe Protocol Kit
    console.log('Initializing Safe Protocol Kit...');
    const safeAddress =
      this.SAFE_WALLETS[chainId as keyof typeof this.SAFE_WALLETS];
    console.log('Safe Address:', safeAddress);

    this.safeProtocolKit = await Safe.init({
      provider: this.rpcUrl,
      signer: this.signerPrivateKey,
      safeAddress: safeAddress,
    });
    console.log('Safe Protocol Kit initialized successfully');
  }

  async createSafeTransaction(
    to: string,
    value: string,
    data: string,
    chainId: string,
  ): Promise<string> {
    console.log('=== Creating Safe Transaction ===');
    console.log('Transaction details:', {
      to,
      value,
      chainId,
      dataLength: data.length,
    });

    // Initialize Safe Protocol Kit for the current chain
    console.log('Initializing Safe wallet for chain:', chainId);
    await this.initializeSafeWallet(chainId);

    // Create transaction data
    console.log('Creating transaction data...');
    const safeTransactionData: MetaTransactionData = {
      to,
      value,
      data,
      operation: OperationType.Call,
    };
    console.log('Transaction data created');

    // Create the transaction
    console.log('Creating Safe transaction...');
    const safeTransaction = await this.safeProtocolKit.createTransaction({
      transactions: [safeTransactionData],
    });
    console.log('Safe transaction created');

    // Get transaction hash
    console.log('Getting transaction hash...');
    const safeTxHash =
      await this.safeProtocolKit.getTransactionHash(safeTransaction);
    console.log('Transaction hash:', safeTxHash);

    // Sign the transaction
    console.log('Signing transaction...');
    const senderSignature = await this.safeProtocolKit.signHash(safeTxHash);
    console.log('Transaction signed');

    // Propose the transaction
    console.log('Proposing transaction...');
    const safeAddress =
      this.SAFE_WALLETS[chainId as keyof typeof this.SAFE_WALLETS];

    await this.safeApiKit.proposeTransaction({
      safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: this.signerAddress,
      senderSignature: senderSignature.data,
    });
    console.log('Transaction proposed successfully');

    return safeTxHash;
  }

  async executeSafeTransaction(
    safeTxHash: string,
    chainId: string,
  ): Promise<string> {
    console.log('=== Executing Safe Transaction ===');
    console.log('Transaction details:', {
      safeTxHash,
      chainId,
    });

    // Initialize Safe Protocol Kit for the current chain
    console.log('Initializing Safe wallet for chain:', chainId);
    await this.initializeSafeWallet(chainId);

    // Get the transaction
    console.log('Fetching transaction details...');
    const safeTransaction = await this.safeApiKit.getTransaction(safeTxHash);
    console.log('Transaction details fetched');

    // Execute the transaction
    console.log('Executing transaction...');
    const executeTxResponse =
      await this.safeProtocolKit.executeTransaction(safeTransaction);
    console.log('Transaction executed successfully');
    console.log('Transaction hash:', executeTxResponse.hash);

    return executeTxResponse.hash;
  }

  getSafeWalletAddress(chainId: string): string | undefined {
    console.log('Getting Safe wallet address for chain:', chainId);
    const address =
      this.SAFE_WALLETS[chainId as keyof typeof this.SAFE_WALLETS];
    console.log('Safe wallet address:', address || 'not found');
    return address;
  }
}
