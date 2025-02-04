import { createToolParameters } from '@goat-sdk/core';
import { z } from 'zod';

// For getting all gauges
export class GetAllGaugesParameters extends createToolParameters(
  z.object({
    voterType: z
      .enum(['veMODE', 'veBPT'])
      .describe('Type of voter contract to query (veMODE or veBPT)'),
  }),
) {}

// For getting specific gauge info
export class GetGaugeInfoParameters extends createToolParameters(
  z.object({
    voterType: z
      .enum(['veMODE', 'veBPT'])
      .describe('Type of voter contract to query (veMODE or veBPT)'),
    gaugeIdentifier: z
      .string()
      .describe('Name or address of the gauge to query'),
    isAddress: z
      .boolean()
      .default(false)
      .describe('Whether the identifier is an address'),
  }),
) {}

// Add this new parameter class
export class VoteOnGaugesParameters extends createToolParameters(
  z.object({
    voterType: z
      .enum(['veMODE', 'veBPT'])
      .describe('Type of voter contract to query (veMODE or veBPT)'),
    tokenId: z
      .string()
      .describe('The NFT token ID representing your voting power'),
    votes: z
      .array(
        z.object({
          gaugeIdentifier: z
            .string()
            .describe('Name or address of the gauge to vote on'),
          isAddress: z
            .boolean()
            .default(false)
            .describe('Whether the identifier is an address'),
          weight: z
            .string()
            .describe('Weight percentage for this gauge (0-100)'),
        }),
      )
      .min(1)
      .describe(
        'Array of gauge identifiers and their corresponding vote weights',
      ),
  }),
) {}

export class ChangeVotesParameters extends createToolParameters(
  z.object({
    voterType: z
      .enum(['veMODE', 'veBPT'])
      .describe('Type of voter contract to query (veMODE or veBPT)'),
    tokenId: z.string().describe('The NFT token ID to change votes for'),
    votes: z
      .array(
        z.object({
          gaugeIdentifier: z
            .string()
            .describe('Name or address of the gauge to vote on'),
          isAddress: z
            .boolean()
            .default(false)
            .describe('Whether the identifier is an address'),
          weight: z
            .string()
            .describe('New weight percentage for this gauge (0-100)'),
        }),
      )
      .min(1)
      .describe('Array of gauge identifiers and their new vote weights'),
  }),
) {}

export class GetVotingPowerParameters extends createToolParameters(
  z.object({
    voterType: z
      .enum(['veMODE', 'veBPT'])
      .describe('Type of voter contract to query (veMODE or veBPT)'),
    tokenId: z.string().describe('The NFT token ID to check voting power for'),
  }),
) {}
