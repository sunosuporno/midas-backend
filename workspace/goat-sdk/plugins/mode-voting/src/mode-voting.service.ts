import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { CLOCK_ABI } from './abi/clock';
import { GAUGE_VOTER_ABI } from './abi/gaugeVoter';
import { VOTING_ESCROW_ABI } from './abi/votingEscrow';
import {
  ChangeVotesParameters,
  GetAllGaugesParameters,
  GetGaugeInfoParameters,
  GetVotingPowerParameters,
  VoteOnGaugesParameters,
} from './parameters';
// Contract addresses for different voter types
const VOTER_ADDRESSES = {
  veMODE: '0x71439Ae82068E19ea90e4F506c74936aE170Cf58',
  veBPT: '0x2aA8A5C1Af4EA11A1f1F10f3b73cfB30419F77Fb',
} as const;

const CLOCK_ADDRESSES = {
  veMODE: '0x66CC481755f8a9d415e75d29C17B0E3eF2Af70bD',
  veBPT: '0x6d1D6277fBB117d77782a85120796BCb08cAae8a',
} as const;

const VOTING_ESCROW_ADDRESSES = {
  veMODE: '0xff8AB822b8A853b01F9a9E9465321d6Fe77c9D2F',
  veBPT: '0x9c2eFe2a1FBfb601125Bb07a3D5bC6EC91F91e01',
} as const;
// Interface for gauge information
interface GaugeInfo {
  address: string;
  active: boolean;
  created: number;
  metadataURI: string;
  totalVotes: string;
  name?: string;
  description?: string;
  eligibilityUrl?: string;
  logo?: string;
}

export class ModeVotingService {
  @Tool({
    name: 'get_all_gauges_mode',
    description:
      "Get a list of all available voting gauges on Mode Network. Use veMODE for MODE token gauges or veBPT for Balancer Pool Token gauges. Don't call this when specific or more detailed information is needed, only for a general list of gauges.",
  })
  async getAllGauges(
    walletClient: EVMWalletClient,
    parameters: GetAllGaugesParameters,
  ): Promise<{
    voterType: keyof typeof VOTER_ADDRESSES;
    gauges: Array<{ address: string; name: string; votes: string }>;
  }> {
    console.log(`Getting all gauges for voter type: ${parameters.voterType}`);
    const voterAddress = VOTER_ADDRESSES[parameters.voterType];
    const DECIMALS = BigInt(10 ** 18);
    const result = {
      voterType: parameters.voterType,
      gauges: [] as Array<{ address: string; name: string; votes: string }>,
    };

    try {
      // Get all gauge addresses
      const gaugesResult = await walletClient.read({
        address: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'getAllGauges',
        args: [],
      });
      const gaugeAddresses = (gaugesResult as { value: string[] }).value;
      console.log(`Found ${gaugeAddresses.length} gauge addresses`);

      // Process each gauge
      result.gauges = await Promise.all(
        gaugeAddresses.map(async (gaugeAddress) => {
          // Get gauge data and votes
          const [gaugeDataResult, votesResult] = await Promise.all([
            walletClient.read({
              address: voterAddress as `0x${string}`,
              abi: GAUGE_VOTER_ABI,
              functionName: 'getGauge',
              args: [gaugeAddress],
            }),
            walletClient.read({
              address: voterAddress as `0x${string}`,
              abi: GAUGE_VOTER_ABI,
              functionName: 'gaugeVotes',
              args: [gaugeAddress],
            }),
          ]);

          const votes = (votesResult as { value: bigint }).value;
          const gaugeData = (
            gaugeDataResult as {
              value: { metadataURI: string };
            }
          ).value;

          let name = 'Unknown';
          try {
            const ipfsHash = gaugeData.metadataURI.replace('ipfs://', '');
            const metadataUrl = `https://externalorgs.mypinata.cloud/ipfs/${ipfsHash}`;
            const metadata = await fetch(metadataUrl).then((res) => res.json());
            name = metadata.name || 'Unknown';
          } catch (error) {
            console.warn(
              `Failed to fetch metadata for gauge ${gaugeAddress}:`,
              error,
            );
          }

          return {
            address: gaugeAddress,
            name,
            votes: (votes / DECIMALS).toString(),
          };
        }),
      );

      return result;
    } catch (error) {
      console.error('Error in getAllGauges:', error);
      throw new Error(
        `Failed to get gauges for ${parameters.voterType}: ${error}`,
      );
    }
  }

  @Tool({
    name: 'get_gauge_info_mode',
    description:
      'Get detailed information about a specific gauge by its name or address. The address returned should not be used as an etherscan address.',
  })
  async getGaugeInfo(
    walletClient: EVMWalletClient,
    parameters: GetGaugeInfoParameters,
  ): Promise<GaugeInfo> {
    console.log(
      `Getting gauge info for identifier: ${parameters.gaugeIdentifier}`,
    );
    try {
      let gaugeAddress = parameters.gaugeIdentifier;

      // If not an address, search by name
      if (!parameters.isAddress) {
        console.log('Searching for gauge by name...');
        // Get all gauges first
        const allGauges = await this.getAllGauges(walletClient, {
          voterType: parameters.voterType,
        });

        // Find the gauge with matching name (case insensitive)
        const searchName = parameters.gaugeIdentifier.toLowerCase();
        const matchingGauge = allGauges.gauges.find((gauge) =>
          gauge.name.toLowerCase().includes(searchName),
        );

        if (!matchingGauge) {
          throw new Error(
            `Could not find a gauge matching the name: ${parameters.gaugeIdentifier}`,
          );
        }

        console.log(
          `Found matching gauge: ${matchingGauge.name} (${matchingGauge.address})`,
        );
        gaugeAddress = matchingGauge.address;
      }

      console.log('voterType', parameters.voterType);

      const gaugeDataResult = await walletClient.read({
        address: VOTER_ADDRESSES[parameters.voterType] as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'getGauge',
        args: [gaugeAddress],
      });

      const gaugeData = (
        gaugeDataResult as {
          value: {
            active: boolean;
            created: bigint;
            metadataURI: string;
          };
        }
      ).value;

      const votesResult = await walletClient.read({
        address: VOTER_ADDRESSES[parameters.voterType] as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'gaugeVotes',
        args: [gaugeAddress],
      });

      const votes = (votesResult as { value: bigint }).value;
      const DECIMALS = BigInt(10 ** 18);

      console.log('Raw votes BigInt:', votes);
      console.log('Decimal string:', votes.toString());
      console.log('After division:', (votes / DECIMALS).toString());
      // Optional: Format with commas for better readability
      console.log(
        'Formatted:',
        Number(votes / DECIMALS).toLocaleString('en-US', {
          maximumFractionDigits: 18,
        }),
      );

      // Fetch metadata
      let metadata = {};
      try {
        const metadataURI = gaugeData.metadataURI;
        const ipfsHash = metadataURI.replace('ipfs://', '');
        const metadataUrl = `https://externalorgs.mypinata.cloud/ipfs/${ipfsHash}`;
        console.log(
          `Fetching metadata from URL: ${metadataUrl} (original URI: ${metadataURI})`,
        );
        const response = await fetch(metadataUrl);
        metadata = await response.json();
        console.log(`Metadata fetched successfully:`, metadata);
      } catch (error) {
        console.error(`Failed to fetch metadata:`, error);
      }

      // Find eligibility URL from resources if it exists
      const eligibilityResource = (metadata as any).resources?.find(
        (resource: any) =>
          resource.field === 'Project Details' &&
          resource.value?.includes('Eligibility Form'),
      );

      const gaugeInfo: GaugeInfo = {
        address: gaugeAddress,
        active: gaugeData.active,
        created: Number(gaugeData.created),
        metadataURI: gaugeData.metadataURI,
        totalVotes: (votes / DECIMALS).toString(),
        name: (metadata as any).name || 'Unknown',
        description: (metadata as any).description,
        logo: (metadata as any).logo,
        eligibilityUrl: eligibilityResource?.url,
      };

      return gaugeInfo;
    } catch (error) {
      console.error(`Error in getGaugeInfo:`, error);
      throw Error(`Failed to get gauge info: ${error}`);
    }
  }

  @Tool({
    name: 'vote_on_gauges_mode',
    description:
      "Vote on multiple gauges using your veNFT voting power. You can specify gauges by their name or address. The sum of weights must equal 100. Remember to not call 'get_voting_power_mode' tool after this.",
  })
  async voteOnGauges(
    walletClient: EVMWalletClient,
    parameters: VoteOnGaugesParameters,
  ): Promise<string> {
    try {
      console.log('Received voting parameters:', {
        voterType: parameters.voterType,
        tokenId: parameters.tokenId,
        votes: parameters.votes.map((vote) => ({
          gaugeIdentifier: vote.gaugeIdentifier,
          isAddress: vote.isAddress,
          weight: vote.weight,
        })),
      });

      // Check if voting is active
      const clockAddress = CLOCK_ADDRESSES[parameters.voterType];

      const votingActiveResult = await walletClient.read({
        address: clockAddress as `0x${string}`,
        abi: CLOCK_ABI,
        functionName: 'votingActive',
        args: [],
      });
      const isVotingActive = (votingActiveResult as { value: boolean }).value;

      if (!isVotingActive) {
        throw new Error('Voting is not currently active');
      }

      // Verify NFT ownership and get voting power
      const voterAddress = VOTER_ADDRESSES[parameters.voterType];
      const escrowAddress = VOTING_ESCROW_ADDRESSES[parameters.voterType];

      const isApprovedResult = await walletClient.read({
        address: escrowAddress as `0x${string}`,
        abi: VOTING_ESCROW_ABI,
        functionName: 'isApprovedOrOwner',
        args: [walletClient.getAddress(), parameters.tokenId],
      });
      const isApproved = (isApprovedResult as { value: boolean }).value;

      if (!isApproved) {
        throw new Error('Not approved or owner of the NFT');
      }

      // Get all gauges for address resolution
      const allGauges = await this.getAllGauges(walletClient, {
        voterType: parameters.voterType,
      });

      // Resolve gauge addresses and prepare votes
      const resolvedVotes = await Promise.all(
        parameters.votes.map(async (vote) => {
          let gaugeAddress = vote.gaugeIdentifier;

          // If not an address, search by name
          if (!vote.isAddress) {
            console.log(`Searching for gauge by name: ${vote.gaugeIdentifier}`);
            const searchName = vote.gaugeIdentifier.toLowerCase();
            console.log('Available gauges and their names:');
            allGauges.gauges.forEach((gauge) => {
              console.log(`- "${gauge.name}" (${gauge.address})`);
            });

            const matchingGauge = allGauges.gauges.find((gauge) => {
              const gaugeName = gauge.name.toLowerCase();
              const matches = gaugeName.includes(searchName);
              console.log(
                `Comparing "${searchName}" with "${gaugeName}": ${matches}`,
              );
              return matches;
            });

            if (!matchingGauge) {
              throw new Error(
                `Could not find a gauge matching the name: ${vote.gaugeIdentifier}`,
              );
            }

            console.log(
              `Found matching gauge: ${matchingGauge.name} (${matchingGauge.address})`,
            );
            gaugeAddress = matchingGauge.address;
          }

          return {
            gauge: gaugeAddress as `0x${string}`,
            weight: BigInt(vote.weight),
          };
        }),
      );

      // Sum of weights validation
      const totalWeight = resolvedVotes.reduce(
        (sum, vote) => sum + BigInt(vote.weight),
        0n,
      );
      if (totalWeight !== 100n) {
        throw new Error('Total vote weight must equal 100');
      }

      // Execute vote transaction
      const txHash = await walletClient.sendTransaction({
        to: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'vote',
        args: [parameters.tokenId, resolvedVotes],
      });

      return `Successfully voted with NFT ${parameters.tokenId}. Transaction: ${txHash.hash}`;
    } catch (error) {
      console.error(`Error in voteOnGauges:`, error);
      throw Error(`Failed to vote on gauges: ${error}`);
    }
  }

  @Tool({
    name: 'change_votes_mode',
    description:
      'Change existing votes for a veNFT. Must reset existing votes first. You can specify gauges by their name or address.',
  })
  async changeVotes(
    walletClient: EVMWalletClient,
    parameters: ChangeVotesParameters,
  ): Promise<string> {
    try {
      console.log('Received vote change parameters:', {
        voterType: parameters.voterType,
        tokenId: parameters.tokenId,
        votes: parameters.votes.map((vote) => ({
          gaugeIdentifier: vote.gaugeIdentifier,
          isAddress: vote.isAddress,
          weight: vote.weight,
        })),
      });

      const voterAddress = VOTER_ADDRESSES[parameters.voterType];

      // First reset existing votes
      const resetTx = await walletClient.sendTransaction({
        to: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'reset',
        args: [parameters.tokenId],
      });

      // Verify votes have been reset by checking usedVotingPower
      const votingPowerResult = await walletClient.read({
        address: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'usedVotingPower',
        args: [parameters.tokenId],
      });
      const usedVotingPower = (votingPowerResult as { value: bigint }).value;

      if (usedVotingPower !== 0n) {
        throw new Error('Failed to reset votes - voting power not cleared');
      }

      // Get all gauges for address resolution
      const allGauges = await this.getAllGauges(walletClient, {
        voterType: parameters.voterType,
      });

      // Resolve gauge addresses and prepare votes
      const resolvedVotes = await Promise.all(
        parameters.votes.map(async (vote) => {
          let gaugeAddress = vote.gaugeIdentifier;

          // If not an address, search by name
          if (!vote.isAddress) {
            console.log(`Searching for gauge by name: ${vote.gaugeIdentifier}`);
            const searchName = vote.gaugeIdentifier.toLowerCase();
            console.log('Available gauges and their names:');
            allGauges.gauges.forEach((gauge) => {
              console.log(`- "${gauge.name}" (${gauge.address})`);
            });

            const matchingGauge = allGauges.gauges.find((gauge) => {
              const gaugeName = gauge.name.toLowerCase();
              const matches = gaugeName.includes(searchName);
              console.log(
                `Comparing "${searchName}" with "${gaugeName}": ${matches}`,
              );
              return matches;
            });

            if (!matchingGauge) {
              throw new Error(
                `Could not find a gauge matching the name: ${vote.gaugeIdentifier}`,
              );
            }

            console.log(
              `Found matching gauge: ${matchingGauge.name} (${matchingGauge.address})`,
            );
            gaugeAddress = matchingGauge.address;
          }

          return {
            gauge: gaugeAddress as `0x${string}`,
            weight: BigInt(vote.weight),
          };
        }),
      );

      // Sum of weights validation
      const totalWeight = resolvedVotes.reduce(
        (sum, vote) => sum + BigInt(vote.weight),
        0n,
      );
      if (totalWeight !== 100n) {
        throw new Error('Total vote weight must equal 100');
      }

      // Execute new vote transaction
      const voteTx = await walletClient.sendTransaction({
        to: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'vote',
        args: [parameters.tokenId, resolvedVotes],
      });
      return `Successfully changed votes for NFT ${parameters.tokenId}. Reset tx: ${resetTx.hash}, Vote tx: ${voteTx.hash}`;
    } catch (error) {
      console.error(`Error in changeVotes:`, error);
      throw Error(`Failed to change votes: ${error}`);
    }
  }

  @Tool({
    name: 'get_voting_power_mode',
    description: 'Get the current voting power for a specific veNFT token ID',
  })
  async getVotingPower(
    walletClient: EVMWalletClient,
    parameters: GetVotingPowerParameters,
  ): Promise<{
    totalVotingPower: string;
    usedVotingPower: string;
    remainingVotingPower: string;
  }> {
    try {
      const escrowAddress = VOTING_ESCROW_ADDRESSES[parameters.voterType];

      const votingPowerResult = await walletClient.read({
        address: escrowAddress as `0x${string}`,
        abi: VOTING_ESCROW_ABI,
        functionName: 'votingPowerAt',
        args: [parameters.tokenId, BigInt(Math.floor(Date.now() / 1000))],
      });
      const votingPower = (votingPowerResult as { value: bigint }).value;

      const voterAddress = VOTER_ADDRESSES[parameters.voterType];
      const usedVotingPowerResult = await walletClient.read({
        address: voterAddress as `0x${string}`,
        abi: GAUGE_VOTER_ABI,
        functionName: 'usedVotingPower',
        args: [parameters.tokenId],
      });
      const usedVotingPower = (usedVotingPowerResult as { value: bigint })
        .value;

      const DECIMALS = BigInt(10 ** 18);

      return {
        totalVotingPower: (votingPower / DECIMALS).toString(),
        usedVotingPower: (usedVotingPower / DECIMALS).toString(),
        remainingVotingPower: (
          (votingPower - usedVotingPower) /
          DECIMALS
        ).toString(),
      };
    } catch (error) {
      throw Error(`Failed to get voting power: ${error}`);
    }
  }
}
