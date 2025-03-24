import { createToolParameters } from '@goat-sdk/core';
import { z } from 'zod';

export class GetPriceParameters extends createToolParameters(
  z.object({
    chainId: z.number().describe('The chain ID to get the price on'),
    sellToken: z
      .string()
      .describe(
        'The address of the token to sell (not the symbol like USDC, USDT, etc.). Look up the address with the appropriate tool to get the token info',
      ),
    buyToken: z
      .string()
      .describe(
        'The address of the token to buy (not the symbol like USDC, USDT, etc.). Look up the address with the appropriate tool to get the token info',
      ),
    sellAmount: z
      .string()
      .describe('The amount of tokens to sell in base units'),
    slippageBps: z
      .number()
      .optional()
      .describe(
        'The maximum acceptable slippage of the buyToken in Bps. If this parameter is set to 0, no slippage will be tolerated. If not provided, the default slippage tolerance is 100Bps',
      ),
  }),
) {}
