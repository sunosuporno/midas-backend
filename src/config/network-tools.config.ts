import { ChainType } from '../dto/agent-call.dto';

export interface ToolDescription {
  basic: string;
  details: Record<string, string>;
}

export interface NetworkToolsConfig {
  available: string[];
  descriptions: Record<string, ToolDescription>;
}

export const networkTools: Record<ChainType, NetworkToolsConfig> = {
  arbitrum: {
    available: ['erc20', 'tokenInfo', 'zeroEx'],
    descriptions: {
      erc20: {
        basic: 'I can help you with ERC20 token operations on Arbitrum',
        details: {
          'check balance':
            "To check your token balance, just ask 'What's my USDC balance on Arbitrum?'",
          transfer:
            "To transfer tokens, say 'Send 10 USDC to 0x... on Arbitrum'",
          approve:
            "To approve tokens, say 'Approve 100 USDC for contract 0x... on Arbitrum'",
        },
      },
      tokenInfo: {
        basic: 'I can fetch token information and market data on Arbitrum',
        details: {
          price: "To check prices, ask 'What's the price of USDC on Arbitrum?'",
          'market data':
            "For market data, say 'Show USDC market data on Arbitrum'",
        },
      },
      zeroEx: {
        basic: 'I can help you swap tokens using 0x Protocol on Arbitrum',
        details: {
          swap: "To swap tokens, say 'Swap 10 USDC to ETH on Arbitrum'",
          quote:
            "To get a quote, ask 'What's the rate for swapping 10 USDC to ETH on Arbitrum?'",
        },
      },
    },
  },
  base: {
    available: ['erc20', 'tokenInfo', 'zeroEx'],
    descriptions: {
      erc20: {
        basic: 'I can help you with ERC20 token operations on Base',
        details: {
          'check balance':
            "To check your token balance, just ask 'What's my USDC balance on Base?'",
          transfer: "To transfer tokens, say 'Send 10 USDC to 0x... on Base'",
          approve:
            "To approve tokens, say 'Approve 100 USDC for contract 0x... on Base'",
        },
      },
      tokenInfo: {
        basic: 'I can fetch token information and market data on Base',
        details: {
          price: "To check prices, ask 'What's the price of USDC on Base?'",
          'market data': "For market data, say 'Show USDC market data on Base'",
        },
      },
      zeroEx: {
        basic: 'I can help you swap tokens using 0x Protocol on Base',
        details: {
          swap: "To swap tokens, say 'Swap 10 USDC to ETH on Base'",
          quote:
            "To get a quote, ask 'What's the rate for swapping 10 USDC to ETH on Base?'",
        },
      },
    },
  },
};

// Helper functions that were in AppService
export const getCapabilitiesResponse = (
  chain: ChainType,
  detailed: boolean = false,
): string => {
  const networkConfig = networkTools[chain];
  if (!networkConfig) {
    return `I'm sorry, I don't have information about my capabilities on this network.`;
  }

  const availableTools = networkConfig.available;
  const descriptions = networkConfig.descriptions;

  let response = `I'm Midas, your DeFi assistant on the ${chain.toUpperCase()} network! Here's what I can help you with:\n\n`;

  if (!detailed) {
    response += availableTools
      .map((tool) => `• ${descriptions[tool].basic}`)
      .join('\n');
    response +=
      '\n\nFor more details about any specific feature, just ask! For example: "How do I swap tokens?" or "How does voting work?"';
  } else {
    availableTools.forEach((tool) => {
      response += `\n📌 ${descriptions[tool].basic}:\n`;
      Object.entries(descriptions[tool].details).forEach(([, explanation]) => {
        response += `   • ${explanation}\n`;
      });
    });
  }

  return response;
};

export const getToolHelp = (chain: ChainType, query: string): string | null => {
  const networkConfig = networkTools[chain];
  if (!networkConfig) return null;

  const toolMatches = {
    swap: 'zeroEx',
    exchange: 'zeroEx',
    trade: 'zeroEx',
    balance: 'erc20',
    transfer: 'erc20',
    send: 'erc20',
    price: 'tokenInfo',
    market: 'tokenInfo',
  };

  const matchedTool = Object.entries(toolMatches).find(([key]) =>
    query.toLowerCase().includes(key),
  )?.[1];

  if (!matchedTool || !networkConfig.available.includes(matchedTool)) {
    return null;
  }

  const toolDesc = networkConfig.descriptions[matchedTool];
  let response = `Here's how you can ${query.toLowerCase().includes('how') ? 'use' : 'work with'} ${matchedTool}:\n\n`;
  Object.values(toolDesc.details).forEach((detail) => {
    response += `• ${detail}\n`;
  });

  return response;
};
