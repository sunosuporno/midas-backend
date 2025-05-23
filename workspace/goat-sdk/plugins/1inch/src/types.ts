export interface BalanceServiceParams {
    baseUrl?: string;
    apiKey?: string;
}

export interface TokenBalance {
    balance: string;
    allowance: string;
}

export interface AggregatedBalancesAndAllowancesResponse {
    [tokenAddress: string]: TokenBalance;
}

export interface SwapResponse {
    fromToken: {
        symbol: string;
        name: string;
        address: string;
        decimals: number;
        logoURI: string;
    };
    toToken: {
        symbol: string;
        name: string;
        address: string;
        decimals: number;
        logoURI: string;
    };
    toTokenAmount: string;
    fromTokenAmount: string;
    protocols: Array<
        Array<{
            name: string;
            part: number;
            fromTokenAddress: string;
            toTokenAddress: string;
        }>
    >;
    tx: {
        from: string;
        to: string;
        data: string;
        value: string;
        gasPrice: string;
        gas: number;
    };
}
