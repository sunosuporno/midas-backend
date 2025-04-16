import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

export class GetQuoteParameters extends createToolParameters(
    z.object({
        chainId: z.number().describe("The chain ID to get the quote on"),
        sellToken: z.string().describe("The address of the token to sell"),
        buyToken: z.string().describe("The address of the token to buy"),
        sellAmount: z
            .string()
            .describe("The amount of tokens to sell in base units"),
        slippageLimitPercent: z
            .number()
            .default(1)
            .describe(
                "The maximum acceptable slippage in percentage. If not provided, the default slippage tolerance is 1",
            ),
    }),
) {}
