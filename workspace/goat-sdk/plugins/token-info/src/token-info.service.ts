import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { ERC20_ABI } from './abi/erc20';
import { TokenInfoParameters } from './parameters';
import { KNOWN_TOKENS } from './token';
import { CoinGeckoToken, TokenInfo } from './types';

export class TokenInfoService {
  private readonly coingeckoBaseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.coingeckoBaseUrl = 'https://api.coingecko.com/api/v3/';
    this.apiKey = apiKey;
  }

  @Tool({
    name: 'get_token_info',
    description: 'Get token information for a given symbol',
  })
  async getTokenInfo(
    walletClient: EVMWalletClient,
    parameters: TokenInfoParameters,
  ): Promise<TokenInfo | null> {
    logger.log('=== getTokenInfo called ===');
    logger.log('Parameters:', parameters);

    const chainId = walletClient.getChain().id;
    logger.log('Chain ID:', chainId);

    // First check known tokens
    const knownToken =
      KNOWN_TOKENS[
        parameters.symbol.toUpperCase() as keyof typeof KNOWN_TOKENS
      ];
    if (knownToken) {
      logger.log('Known token found:', knownToken);

      const chainData = knownToken.chains[chainId.toString()];
      if (chainData) {
        logger.log('Returning known token info:', {
          symbol: knownToken.symbol,
          name: knownToken.name,
          decimals: knownToken.decimals,
          contractAddress: chainData.contractAddress,
        });

        return {
          symbol: knownToken.symbol,
          name: knownToken.name,
          decimals: knownToken.decimals,
          contractAddress: chainData.contractAddress,
        };
      } else {
        logger.log(
          'Token not available on current network, querying CoinGecko',
        );
      }
    } else {
      logger.log('Token not found in known tokens, querying CoinGecko');
    }

    // Query CoinGecko if token is not found or not available on the current network
    try {
      const response = await fetch(
        `${this.coingeckoBaseUrl}coins/list?include_platform=true`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-cg-demo-api-key': this.apiKey,
          },
        },
      );
      const data: CoinGeckoToken[] = await response.json();

      const matches = data.filter(
        (token) =>
          token.symbol.toLowerCase() === parameters.symbol.toLowerCase(),
      );
      logger.log('Matching tokens from CoinGecko:', matches);

      for (const token of matches) {
        const platformAddress = this.getPlatformAddressForChainId(
          token.platforms,
          chainId,
        );

        if (platformAddress) {
          logger.log('Platform address found:', platformAddress);

          const tokenDecimals = await walletClient.read({
            address: platformAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'decimals',
          });
          const tokenDecimalsParsed = (tokenDecimals as { value: number })
            .value;

          logger.log('Token decimals:', tokenDecimalsParsed);

          return {
            symbol: token.symbol.toUpperCase(),
            name: token.name,
            contractAddress: platformAddress as `0x${string}`,
            decimals: tokenDecimalsParsed,
          };
        }
      }
      logger.log(
        'No matching tokens found on CoinGecko for the current chain',
      );
      return null;
    } catch (error) {
      logger.error('Error querying CoinGecko:', error);
      return null;
    }
  }

  private getPlatformAddressForChainId(
    platforms: Record<string, string> | undefined,
    chainId: number,
  ): string | null {
    if (!platforms) return null;

    // Map chain IDs to CoinGecko platform identifiers
    const platformMap: Record<number, string> = {
      1: 'ethereum',
      137: 'polygon-pos',
      10: 'optimistic-ethereum',
      42161: 'arbitrum-one',
      8453: 'base',
      34443: 'mode',
      5000: 'mantle',
      // Add more mappings as needed
    };
    const platformIdentifier = platformMap[chainId];
    if (!platformIdentifier) {
      return null;
    }
    if (platforms[platformIdentifier]) {
      return platforms[platformIdentifier];
    }
    return null;
  }
}
