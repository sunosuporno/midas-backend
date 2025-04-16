import { PluginBase } from "@goat-sdk/core";
import { Chain } from "@goat-sdk/core";
import { EVMWalletClient } from "@goat-sdk/wallet-evm";
import { OdosService } from "./odos.service";

const supportedChains = [
    "1", // Ethereum
    "42161", // Arbitrum
    "43114", // Avalanche
    "8453", // Base
    "81457", // Blast
    "56", // BSC
    "59144", // Linea
    "5000", // Mantle
    "34443", // Mode
    "10", // Optimism
    "137", // Polygon
    "534352", // Scroll
    "480", // Worldcoin
];

export class OdosPlugin extends PluginBase<EVMWalletClient> {
    constructor() {
        super("odos", [new OdosService()]);
    }

    supportsChain = (chain: Chain) =>
        chain.type === "evm" && supportedChains.includes(chain.id.toString());
}

export function odos() {
    return new OdosPlugin();
}
