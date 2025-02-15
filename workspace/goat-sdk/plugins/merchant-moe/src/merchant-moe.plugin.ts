import { type Chain, PluginBase } from "@goat-sdk/core";
import type { EVMWalletClient } from "@goat-sdk/wallet-evm";
import { mantle } from "viem/chains";
import { MerchantMoeService } from "./merchant-moe.service";

const SUPPORTED_CHAINS = [mantle];

export class MerchantMoePlugin extends PluginBase<EVMWalletClient> {
    constructor() {
        super("merchant-moe", [new MerchantMoeService()]);
    }

    supportsChain = (chain: Chain) =>
        chain.type === "evm" && SUPPORTED_CHAINS.some((c) => c.id === chain.id);
}

export const merchantMoe = () => new MerchantMoePlugin();
