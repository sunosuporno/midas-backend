import { z } from "zod";
import { createToolParameters } from "@goat-sdk/core";

export class AddLiquidityParams extends createToolParameters(
    z.object({
        token0Address: z.string().describe("The address of the first token"),
        token1Address: z.string().describe("The address of the second token"),
        amount0Desired: z.string().describe("The amount of token0 to add"),
        amount1Desired: z.string().describe("The amount of token1 to add"),
        amount0Min: z
            .string()
            .default("0")
            .describe("The minimum amount of token0 to add"),
        amount1Min: z
            .string()
            .default("0")
            .describe("The minimum amount of token1 to add"),
    })
) {}
