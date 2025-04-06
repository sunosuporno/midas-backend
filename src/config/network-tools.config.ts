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
  mode: {
    available: [
      'erc20',
      'modeVoting',
      'kim',
      'ironclad',
      'tokenInfo',
      'zeroEx',
    ],
    descriptions: {
      erc20: {
        basic:
          'I can help you with ERC20 token operations (USDC, USDT, MODE, WETH, ezETH, wrsETH)',
        details: {
          'check balance':
            "To check your token balance, just ask 'What's my MODE balance?' or 'Show my USDC balance'",
          transfer:
            "To transfer tokens, say 'Send 10 USDC to 0x...' or 'Transfer 5 MODE to...'",
          approve:
            "To approve tokens, say 'Approve 100 USDC for contract 0x...'",
        },
      },
      modeVoting: {
        basic: "I can assist with Mode's governance system",
        details: {
          'view proposals':
            "Ask 'Show me active proposals' or 'What can I vote on?'",
          vote: "To vote, say 'Vote yes on proposal 1' or 'Vote no on the latest proposal'",
        },
      },
      zeroEx: {
        basic: 'I can help you swap tokens using 0x Protocol',
        details: {
          swap: "To swap tokens, say 'Swap 10 USDC to MODE' or 'Exchange 5 MODE for USDC'",
          quote:
            "To get a quote, ask 'What's the rate for swapping 10 USDC to MODE?'",
        },
      },
      kim: {
        basic: "I can help you interact with Kim Finance's protocol",
        details: {
          stake: "To stake tokens, say 'Stake 100 MODE in Kim Finance'",
          rewards: "To check rewards, ask 'Show my Kim Finance rewards'",
        },
      },
      ironclad: {
        basic: "I can help you with Ironclad's protocol operations",
        details: {
          deposit: "To deposit, say 'Deposit 100 USDC to Ironclad'",
          withdraw: "To withdraw, say 'Withdraw my funds from Ironclad'",
        },
      },
      tokenInfo: {
        basic: 'I can fetch token information and market data',
        details: {
          price:
            "To check prices, ask 'What's the price of MODE?' or 'Show USDC price'",
          'market data':
            "For market data, say 'Show MODE market data' or 'What's USDC market cap?'",
        },
      },
      merchantMoe: {
        basic: "I can help you with Merchant Moe's marketplace",
        details: {
          trade: "To trade, say 'Trade 10 USDC for MODE on Merchant Moe'",
          pool: "To check pools, ask 'Show Merchant Moe pools'",
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
        },
      },
      tokenInfo: {
        basic: 'I can fetch token information and market data on Base',
        details: {
          price: "To check prices, ask 'What's the price of USDC on Base?'",
        },
      },
      zeroEx: {
        basic: 'I can help you swap tokens using 0x Protocol on Base',
        details: {
          swap: "To swap tokens, say 'Swap 10 USDC to ETH on Base'",
        },
      },
    },
  },
  mantle: {
    available: ['erc20', 'tokenInfo', 'zeroEx'],
    descriptions: {
      erc20: {
        basic: 'I can help you with ERC20 token operations on Mantle',
        details: {
          'check balance':
            "To check your token balance, just ask 'What's my USDC balance on Mantle?'",
          transfer: "To transfer tokens, say 'Send 10 USDC to 0x... on Mantle'",
        },
      },
      tokenInfo: {
        basic: 'I can fetch token information and market data on Mantle',
        details: {
          price: "To check prices, ask 'What's the price of USDC on Mantle?'",
        },
      },
      zeroEx: {
        basic: 'I can help you swap tokens using 0x Protocol on Mantle',
        details: {
          swap: "To swap tokens, say 'Swap 10 USDC to ETH on Mantle'",
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
    vote: 'modeVoting',
    proposal: 'modeVoting',
    governance: 'modeVoting',
    balance: 'erc20',
    transfer: 'erc20',
    send: 'erc20',
    stake: 'kim',
    ironclad: 'ironclad',
    merchant: 'merchantMoe',
    price: 'tokenInfo',
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
