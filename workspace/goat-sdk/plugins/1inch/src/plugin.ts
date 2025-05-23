import { PluginBase, Chain } from "@goat-sdk/core";
import { EVMWalletClient } from "@goat-sdk/wallet-evm";
import { OneInchService } from "./service";

export type OneInchCtorParams = {
    apiKey: string;
};

const supportedChains: string[] = [
    "1",
    "42161", // arbitrum
    "43114", // avalanche
    "8453", // base
    "56", // bsc
    "59144", // linea
    "10", // optimism
    "137", // polygon
    "324", // zkSync
];

export class OneInchPlugin extends PluginBase<EVMWalletClient> {
    constructor(params: OneInchCtorParams) {
        super("1inch", [new OneInchService({ apiKey: params.apiKey })]);
    }

    supportsChain = (chain: Chain) =>
        chain.type === "evm" && supportedChains.includes(chain.id.toString());
}

export function oneInch(params: OneInchCtorParams) {
    return new OneInchPlugin(params);
}
