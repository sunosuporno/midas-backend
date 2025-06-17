import { createToolParameters } from '@goat-sdk/core';
import { z } from 'zod';

export class SendTipParameters extends createToolParameters(
  z.object({
    recipient: z
      .string()
      .describe('The X handle of the recipient (e.g., @username)'),
    tokenAddress: z.string().describe('The address of the token to send'),
    amount: z.string().describe('The amount of tokens to send (in base units)'),
  }),
) {}

export class ClaimPendingTipsParameters extends createToolParameters(
  z.object({}),
) {}
