export class SendTransactionDto {
  // No fields needed - everything will be hardcoded in the backend
}

export class SendTransactionResponseDto {
  id: string;
  status: string;
  transactionHash?: string;
  error?: string;
}
