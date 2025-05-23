import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

export class GetBalancesParameters extends createToolParameters(
    z.object({
        walletAddress: z
            .string()
            .optional()
            .describe("The wallet address to check balances for"),
    }),
) {}

export class SwapParameters extends createToolParameters(
    z.object({
        fromTokenAddress: z.string().describe("The token address to swap from"),
        toTokenAddress: z.string().describe("The token address to swap to"),
        amount: z
            .string()
            .describe(
                "The amount of tokens to swap in base units of the token. Eg: 1000000 for 1 USDC",
            ),
        fromAddress: z.string().optional().describe("The address to swap from"),
        slippage: z
            .number()
            .optional()
            .default(1)
            .describe("The maximum acceptable slippage in percentage"),
    }),
) {}
