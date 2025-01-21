var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __decorateClass = (decorators, target, key, kind) => {
  var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
  for (var i = decorators.length - 1, decorator; i >= 0; i--)
    if (decorator = decorators[i])
      result = (kind ? decorator(target, key, result) : decorator(result)) || result;
  if (kind && result) __defProp(target, key, result);
  return result;
};

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ERC20Plugin: () => ERC20Plugin,
  MODE: () => MODE,
  PEPE: () => PEPE,
  USDC: () => USDC,
  WETH: () => WETH,
  erc20: () => erc20,
  getTokensForNetwork: () => getTokensForNetwork
});
module.exports = __toCommonJS(index_exports);

// src/token.ts
var PEPE = {
  decimals: 18,
  symbol: "PEPE",
  name: "Pepe",
  chains: {
    "1": {
      contractAddress: "0x6982508145454Ce325dDbE47a25d4ec3d2311933"
    },
    "10": {
      contractAddress: "0xc1c167cc44f7923cd0062c4370df962f9ddb16f5"
    },
    "8453": {
      contractAddress: "0xb4fde59a779991bfb6a52253b51947828b982be3"
    }
  }
};
var USDC = {
  decimals: 6,
  symbol: "USDC",
  name: "USDC",
  chains: {
    "1": {
      contractAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    },
    "10": {
      contractAddress: "0x0b2c639c533813f4aa9d7837caf62653d097ff85"
    },
    "137": {
      contractAddress: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"
    },
    "8453": {
      contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    },
    "84532": {
      contractAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
    },
    "11155111": {
      contractAddress: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
    },
    "34443": {
      contractAddress: "0xd988097fb8612cc24eeC14542bC03424c656005f"
    }
  }
};
var MODE = {
  decimals: 18,
  symbol: "MODE",
  name: "Mode",
  chains: {
    "34443": {
      contractAddress: "0xDfc7C877a950e49D2610114102175A06C2e3167a"
    }
  }
};
var WETH = {
  decimals: 18,
  symbol: "WETH",
  name: "Wrapped Ether",
  chains: {
    "1": {
      contractAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
    },
    "8453": {
      contractAddress: "0x4200000000000000000000000000000000000006"
    },
    "34443": {
      contractAddress: "0x4200000000000000000000000000000000000006"
    },
    "42161": {
      contractAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
    },
    "10": {
      contractAddress: "0x4200000000000000000000000000000000000006"
    },
    "137": {
      contractAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"
    }
  }
};
function getTokensForNetwork(chainId, tokens) {
  const result = [];
  for (const token of tokens) {
    const chainData = token.chains[chainId];
    if (chainData) {
      result.push({
        chainId,
        decimals: token.decimals,
        symbol: token.symbol,
        name: token.name,
        contractAddress: chainData.contractAddress
      });
    }
  }
  return result;
}

// src/erc20.plugin.ts
var import_core2 = require("@goat-sdk/core");

// src/erc20.service.ts
var import_core = require("@goat-sdk/core");

// src/abi.ts
var import_viem = require("viem");
var ERC20_ABI = (0, import_viem.parseAbi)([
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)"
]);

// src/erc20.service.ts
var Erc20Service = class {
  constructor({ tokens } = {}) {
    this.tokens = tokens ?? [];
  }
  async getTokenInfoBySymbol(walletClient, parameters) {
    const token = this.tokens.find(
      (token2) => [token2.symbol, token2.symbol.toLowerCase()].includes(parameters.symbol)
    );
    if (!token) {
      throw Error(`Token with symbol ${parameters.symbol} not found`);
    }
    const chain = walletClient.getChain();
    const contractAddress = token.chains[chain.id]?.contractAddress;
    if (!contractAddress) {
      throw Error(`Token with symbol ${parameters.symbol} not found on chain ${chain.id}`);
    }
    return {
      symbol: token?.symbol,
      contractAddress,
      decimals: token?.decimals,
      name: token?.name
    };
  }
  async getTokenBalance(walletClient, parameters) {
    try {
      const resolvedWalletAddress = await walletClient.resolveAddress(parameters.wallet);
      const rawBalance = await walletClient.read({
        address: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [resolvedWalletAddress]
      });
      return Number(rawBalance.value);
    } catch (error) {
      throw Error(`Failed to fetch balance: ${error}`);
    }
  }
  async transfer(walletClient, parameters) {
    try {
      const to = await walletClient.resolveAddress(parameters.to);
      const hash = await walletClient.sendTransaction({
        to: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, parameters.amount]
      });
      return hash.hash;
    } catch (error) {
      throw Error(`Failed to transfer: ${error}`);
    }
  }
  async getTokenTotalSupply(walletClient, parameters) {
    try {
      const rawTotalSupply = await walletClient.read({
        address: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "totalSupply"
      });
      return rawTotalSupply.value;
    } catch (error) {
      throw Error(`Failed to fetch total supply: ${error}`);
    }
  }
  async getTokenAllowance(walletClient, parameters) {
    try {
      const owner = await walletClient.resolveAddress(parameters.owner);
      const spender = await walletClient.resolveAddress(parameters.spender);
      const rawAllowance = await walletClient.read({
        address: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [owner, spender]
      });
      return Number(rawAllowance.value);
    } catch (error) {
      throw Error(`Failed to fetch allowance: ${error}`);
    }
  }
  async approve(walletClient, parameters) {
    try {
      const spender = await walletClient.resolveAddress(parameters.spender);
      const hash = await walletClient.sendTransaction({
        to: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, parameters.amount]
      });
      return hash.hash;
    } catch (error) {
      throw Error(`Failed to approve: ${error}`);
    }
  }
  async revokeApproval(walletClient, parameters) {
    try {
      const spender = await walletClient.resolveAddress(parameters.spender);
      const hash = await walletClient.sendTransaction({
        to: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, 0]
      });
      return hash.hash;
    } catch (error) {
      throw Error(`Failed to revoke approval: ${error}`);
    }
  }
  async transferFrom(walletClient, parameters) {
    try {
      const from = await walletClient.resolveAddress(parameters.from);
      const to = await walletClient.resolveAddress(parameters.to);
      const hash = await walletClient.sendTransaction({
        to: parameters.tokenAddress,
        abi: ERC20_ABI,
        functionName: "transferFrom",
        args: [from, to, parameters.amount]
      });
      return hash.hash;
    } catch (error) {
      throw Error(`Failed to transfer from: ${error}`);
    }
  }
  async convertToBaseUnit(parameters) {
    const { amount, decimals } = parameters;
    const baseUnit = amount * 10 ** decimals;
    return Number(baseUnit);
  }
  async convertFromBaseUnit(parameters) {
    const { amount, decimals } = parameters;
    const decimalUnit = amount / 10 ** decimals;
    return Number(decimalUnit);
  }
};
__decorateClass([
  (0, import_core.Tool)({
    description: "Get the ERC20 token info by its symbol, including the contract address, decimals, and name"
  })
], Erc20Service.prototype, "getTokenInfoBySymbol", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Get the balance of an ERC20 token in base units. Convert to decimal units before returning."
  })
], Erc20Service.prototype, "getTokenBalance", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Transfer an amount of an ERC20 token to an address"
  })
], Erc20Service.prototype, "transfer", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Get the total supply of an ERC20 token"
  })
], Erc20Service.prototype, "getTokenTotalSupply", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Get the allowance of an ERC20 token"
  })
], Erc20Service.prototype, "getTokenAllowance", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Approve an amount of an ERC20 token to an address"
  })
], Erc20Service.prototype, "approve", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Revoke approval for an ERC20 token to an address"
  })
], Erc20Service.prototype, "revokeApproval", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Transfer an amount of an ERC20 token from an address to another address"
  })
], Erc20Service.prototype, "transferFrom", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Convert an amount of an ERC20 token to its base unit"
  })
], Erc20Service.prototype, "convertToBaseUnit", 1);
__decorateClass([
  (0, import_core.Tool)({
    description: "Convert an amount of an ERC20 token from its base unit to its decimal unit"
  })
], Erc20Service.prototype, "convertFromBaseUnit", 1);

// src/erc20.plugin.ts
var ERC20Plugin = class extends import_core2.PluginBase {
  constructor({ tokens }) {
    super("erc20", [new Erc20Service({ tokens })]);
    this.supportsChain = (chain) => chain.type === "evm";
  }
};
function erc20({ tokens }) {
  return new ERC20Plugin({ tokens });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ERC20Plugin,
  MODE,
  PEPE,
  USDC,
  WETH,
  erc20,
  getTokensForNetwork
});
//# sourceMappingURL=index.js.map