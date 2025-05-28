import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { ERC20_ABI } from './abi/erc20';
import { MERCHANT_MOE_ROUTER_ABI } from './abi/router';
import { AddLiquidityParams } from './parameters';

const MERCHANT_MOE_ROUTER_ADDRESS =
  '0xeaEE7EE68874218c3558b40063c42B82D3E7232a';

export class MerchantMoeService {
  @Tool({
    description: 'Add liquidity to a pool in Merchant Moe',
  })
  async addLiquidity(
    walletClient: EVMWalletClient,
    parameters: AddLiquidityParams,
  ) {
    const isOrderMatched =
      parameters.token0Address.toLowerCase() <
      parameters.token1Address.toLowerCase();

    // Set tokens and amounts in correct order
    const [token0, token1] = isOrderMatched
      ? [parameters.token0Address, parameters.token1Address]
      : [parameters.token1Address, parameters.token0Address];

    const [amount0Raw, amount1Raw] = isOrderMatched
      ? [parameters.amount0Desired, parameters.amount1Desired]
      : [parameters.amount1Desired, parameters.amount0Desired];

    await walletClient.sendTransaction({
      to: token0 as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [MERCHANT_MOE_ROUTER_ADDRESS, amount0Raw],
    });

    await walletClient.sendTransaction({
      to: token1 as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [MERCHANT_MOE_ROUTER_ADDRESS, amount1Raw],
    });

    const timestamp = Math.floor(Date.now() / 1000) + parameters.deadline;

    const hash = await walletClient.sendTransaction({
      to: MERCHANT_MOE_ROUTER_ADDRESS,
      abi: MERCHANT_MOE_ROUTER_ABI,
      functionName: 'addLiquidity',
      args: [
        token0,
        token1,
        amount0Raw,
        amount1Raw,
        0,
        0,
        walletClient.getAddress(),
        timestamp,
      ],
    });

    return hash.hash;
  }
}
