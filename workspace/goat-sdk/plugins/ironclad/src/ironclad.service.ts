import { Tool } from '@goat-sdk/core';
import { EVMWalletClient } from '@goat-sdk/wallet-evm';
import { formatUnits } from 'viem';
import { BORROWER_ABI } from './abi/borrower';
import { ERC20_ABI } from './abi/erc20';
import { HINT_HELPERS_ABI } from './abi/hinthelper';
import { IC_VAULT_ABI } from './abi/icVault';
import { LENDING_POOL_ABI } from './abi/lendingPool';
import { PROTOCOL_DATA_PROVIDER_ABI } from './abi/protocolDataProvider';
import { TROVE_MANAGER_ABI } from './abi/troveManager';
import {
  BorrowIUSDParameters,
  CalculateMaxWithdrawableParameters,
  GetBorrowerAddressParameters,
  GetIcVaultParameters,
  GetLendingPoolAddressParameters,
  LoopDepositParameters,
  LoopWithdrawParameters,
  MonitorPositionParameters,
  RepayIUSDParameters,
  DepositParameters,
  BorrowParameters,
  WithdrawParameters,
  RepayParameters,
  MonitorLendingPositionParameters,
} from './parameters';
import { getVaultAddress } from './vaultAddresses';

interface LoopPosition {
  borrowedAmounts: string[];
  totalDeposited: string;
  totalBorrowed: string;
}

const LENDING_POOL_ADDRESS = '0xB702cE183b4E1Faa574834715E5D4a6378D0eEd3';
const PROTOCOL_DATA_PROVIDER_ADDRESS =
  '0x29563f73De731Ae555093deb795ba4D1E584e42E';
const IUSD_ADDRESS = '0xA70266C8F8Cf33647dcFEE763961aFf418D9E1E4';
const BORROWER_ADDRESS = '0x9571873B4Df31D317d4ED4FE4689915A2F3fF7d4';
const TROVE_MANAGER_ADDRESS = '0x829746b34F624fdB03171AA4cF4D2675B0F2A2e6';
const HINT_HELPERS_ADDRESS = '0xBdAA7033f0A109A9777ee42a82799642a877Fc4b';
export class IroncladService {
  @Tool({
    name: 'loop_deposit_ironclad',
    description:
      'Perform a looped deposit (recursive borrowing) on Ironclad. Send the amount of the asset (in base units) you want to deposit as the initial amount. Call this function only when the user asks to loop deposit.',
  })
  async loopDeposit(
    walletClient: EVMWalletClient,
    parameters: LoopDepositParameters,
  ): Promise<LoopPosition> {
    try {
      const position: LoopPosition = {
        borrowedAmounts: [],
        totalDeposited: '0',
        totalBorrowed: '0',
      };

      const asset = parameters.assetAddress;

      // Initial deposit
      await walletClient.sendTransaction({
        to: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: 'deposit',
        args: [
          asset,
          parameters.initialAmount,
          walletClient.getAddress(),
          parameters.referralCode,
        ],
      });

      position.totalDeposited = parameters.initialAmount;
      let currentAmount = parameters.initialAmount;

      // Execute loops
      for (let i = 0; i < parameters.numLoops; i++) {
        const reserveConfigResult = await walletClient.read({
          address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
          abi: PROTOCOL_DATA_PROVIDER_ABI,
          functionName: 'getReserveConfigurationData',
          args: [asset],
        });
        const reserveConfig = reserveConfigResult.value as [
          bigint,
          bigint,
          bigint,
        ];

        const ltv = Number(reserveConfig[1]);

        const borrowAmount = ((Number(currentAmount) * ltv) / 10000).toString();

        // Borrow
        await walletClient.sendTransaction({
          to: LENDING_POOL_ADDRESS,
          abi: LENDING_POOL_ABI,
          functionName: 'borrow',
          args: [
            asset,
            borrowAmount,
            2, // Variable rate mode
            parameters.referralCode,
            walletClient.getAddress(),
          ],
        });

        const loopAllowanceResult = await walletClient.read({
          address: asset as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [walletClient.getAddress(), LENDING_POOL_ADDRESS],
        });
        const loopAllowance = (loopAllowanceResult as { value: bigint }).value;

        if (Number(loopAllowance) < Number(borrowAmount)) {
          await walletClient.sendTransaction({
            to: asset,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [LENDING_POOL_ADDRESS, borrowAmount],
          });
        }

        // Deposit
        await walletClient.sendTransaction({
          to: LENDING_POOL_ADDRESS,
          abi: LENDING_POOL_ABI,
          functionName: 'deposit',
          args: [
            asset,
            borrowAmount,
            walletClient.getAddress(),
            parameters.referralCode,
          ],
        });

        // Update position tracking
        position.borrowedAmounts.push(borrowAmount);
        position.totalBorrowed = (
          Number(position.totalBorrowed) + Number(borrowAmount)
        ).toString();
        position.totalDeposited = (
          Number(position.totalDeposited) + Number(borrowAmount)
        ).toString();
        currentAmount = borrowAmount;
      }
      return position;
    } catch (error) {
      throw Error(`Failed to execute loop deposit: ${error}`);
    }
  }

  @Tool({
    name: 'loop_withdraw_ironclad',
    description: 'Withdraw a looped position on Ironclad',
  })
  async loopWithdraw(
    walletClient: EVMWalletClient,
    parameters: LoopWithdrawParameters,
  ): Promise<string> {
    try {
      console.log('\n=== Starting Loop Withdrawal ===');
      console.log('Asset Address:', parameters.assetAddress);
      console.log('User Address:', walletClient.getAddress());

      const userReserveDataResult = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData',
        args: [parameters.assetAddress, walletClient.getAddress()],
      });

      const userReserveData = userReserveDataResult.value as [
        bigint,
        bigint,
        bigint,
      ];
      let remainingDebt = userReserveData[2]; // currentVariableDebt
      console.log('Initial Debt:', remainingDebt.toString());

      let withdrawalCount = 1;
      while (remainingDebt > 0n) {
        console.log(`\n--- Processing Withdrawal Loop ${withdrawalCount} ---`);
        const maxWithdrawable = await this.calculateMaxWithdrawableAmount(
          walletClient,
          {
            assetAddress: parameters.assetAddress,
          },
        );
        console.log('Max Withdrawable Amount:', maxWithdrawable.toString());

        if (maxWithdrawable === 0n) {
          console.error('Cannot withdraw: Health factor limit reached');
          throw new Error(
            'Cannot withdraw any more funds while maintaining health factor',
          );
        }

        const withdrawAmount =
          remainingDebt === 0n
            ? maxWithdrawable
            : (maxWithdrawable * 995n) / 1000n;
        console.log('Withdrawal Amount:', withdrawAmount.toString());

        console.log('Executing withdrawal...');
        await walletClient.sendTransaction({
          to: LENDING_POOL_ADDRESS,
          abi: LENDING_POOL_ABI,
          functionName: 'withdraw',
          args: [
            parameters.assetAddress,
            withdrawAmount,
            walletClient.getAddress(),
          ],
        });

        const allowanceResult = await walletClient.read({
          address: parameters.assetAddress as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [walletClient.getAddress(), LENDING_POOL_ADDRESS],
        });
        const allowance = (allowanceResult as { value: bigint }).value;
        console.log('Current Allowance:', allowance.toString());

        if (allowance < withdrawAmount) {
          console.log('Approving tokens for repayment...');
          await walletClient.sendTransaction({
            to: parameters.assetAddress,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [LENDING_POOL_ADDRESS, withdrawAmount],
          });
        }

        console.log('Executing repayment...');
        await walletClient.sendTransaction({
          to: LENDING_POOL_ADDRESS,
          abi: LENDING_POOL_ABI,
          functionName: 'repay',
          args: [
            parameters.assetAddress,
            withdrawAmount,
            2,
            walletClient.getAddress(),
          ],
        });

        const updatedReserveData = await walletClient.read({
          address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
          abi: PROTOCOL_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [parameters.assetAddress, walletClient.getAddress()],
        });

        remainingDebt = (updatedReserveData.value as any)[2];
        console.log('Remaining Debt:', remainingDebt.toString());
        withdrawalCount++;
      }

      console.log('\n=== Checking Final Position ===');
      const finalReserveData = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData',
        args: [parameters.assetAddress, walletClient.getAddress()],
      });
      const remainingDeposit = (finalReserveData.value as any)[0];
      console.log('Remaining Deposit:', remainingDeposit.toString());

      if (remainingDeposit > 0n) {
        console.log('Withdrawing remaining deposits...');
        await walletClient.sendTransaction({
          to: LENDING_POOL_ADDRESS,
          abi: LENDING_POOL_ABI,
          functionName: 'withdraw',
          args: [
            parameters.assetAddress,
            remainingDeposit,
            walletClient.getAddress(),
          ],
        });
      }

      console.log('\n=== Loop Withdrawal Complete ===');
      return `Successfully unwound position in ${withdrawalCount - 1} loops`;
    } catch (error) {
      console.error('Loop Withdrawal Failed:', error);
      throw Error(`Failed to execute loop withdraw: ${error}`);
    }
  }

  @Tool({
    name: 'monitor_loop_position_ironclad',
    description: 'Monitor health of a looped position on Ironclad',
  })
  async monitorLoopPosition(
    walletClient: EVMWalletClient,
    parameters: MonitorPositionParameters,
  ): Promise<{
    totalCollateral: string;
    totalBorrowed: string;
    currentLTV: string;
    healthFactor: string;
    liquidationThreshold: string;
  }> {
    try {
      console.log('\n=== Monitoring Loop Position ===');
      console.log('Asset Address:', parameters.tokenAddress);
      console.log('User Address:', walletClient.getAddress());

      // Get token decimals
      const decimalsResult = await walletClient.read({
        address: parameters.tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      });
      const decimals = Number((decimalsResult as { value: number }).value);
      console.log('Token Decimals:', decimals);

      // Get user's reserve data
      console.log('\n--- Fetching User Reserve Data ---');
      const userReserveDataResult = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData',
        args: [parameters.tokenAddress, walletClient.getAddress()],
      });
      const userReserveData = userReserveDataResult.value as [
        bigint,
        bigint,
        bigint,
      ];
      console.log('Raw User Reserve Data:', {
        aTokenBalance: userReserveData[0].toString(),
        stableDebt: userReserveData[1].toString(),
        variableDebt: userReserveData[2].toString(),
      });

      // Get reserve configuration
      console.log('\n--- Fetching Reserve Configuration ---');
      const reserveConfigResult = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getReserveConfigurationData',
        args: [parameters.tokenAddress],
      });
      const reserveConfig = reserveConfigResult.value as [
        bigint,
        bigint,
        bigint,
      ];
      console.log('Raw Reserve Config:', {
        ltv: reserveConfig[1].toString(),
        liquidationThreshold: reserveConfig[2].toString(),
      });

      // Parse position data
      console.log('\n--- Calculating Position Metrics ---');
      const totalCollateral = formatUnits(userReserveData[0], decimals);
      const totalBorrowed = formatUnits(userReserveData[2], decimals);
      const liquidationThreshold = Number(reserveConfig[2]) / 10000;

      console.log('Position Data:', {
        rawCollateral: userReserveData[0].toString(),
        formattedCollateral: totalCollateral,
        rawBorrowed: userReserveData[2].toString(),
        formattedBorrowed: totalBorrowed,
        liquidationThreshold: `${(liquidationThreshold * 100).toFixed(2)}%`,
      });

      // Calculate risk metrics
      console.log('\n--- Computing Risk Metrics ---');
      const currentLTV =
        totalBorrowed === '0'
          ? '0'
          : ((Number(totalBorrowed) / Number(totalCollateral)) * 100).toFixed(
              2,
            );

      const healthFactor =
        totalBorrowed === '0'
          ? '∞'
          : (
              (Number(totalCollateral) * liquidationThreshold) /
              Number(totalBorrowed)
            ).toFixed(2);

      console.log('Risk Metrics:', {
        currentLTV: `${currentLTV}%`,
        healthFactor,
        liquidationThreshold: `${(liquidationThreshold * 100).toFixed(2)}%`,
      });

      console.log('\n--- Position Summary ---');
      console.log('Total Collateral:', totalCollateral);
      console.log('Total Borrowed:', totalBorrowed);
      console.log('Current LTV:', `${currentLTV}%`);
      console.log('Health Factor:', healthFactor);
      console.log(
        'Liquidation Threshold:',
        `${(liquidationThreshold * 100).toFixed(2)}%`,
      );

      console.log('\n=== Loop Position Monitoring Complete ===');

      return {
        totalCollateral,
        totalBorrowed,
        currentLTV: `${currentLTV}%`,
        healthFactor,
        liquidationThreshold: `${(liquidationThreshold * 100).toFixed(2)}%`,
      };
    } catch (error) {
      console.error('\n❌ Error Monitoring Loop Position ❌');
      console.error('Error Details:', error);
      throw Error(`Failed to monitor loop position: ${error}`);
    }
  }

  @Tool({
    name: 'borrow_iusd_ironclad',
    description: 'Deposit collateral and borrow iUSD against it',
  })
  async borrowIUSD(
    walletClient: EVMWalletClient,
    parameters: BorrowIUSDParameters,
  ): Promise<string> {
    try {
      const vaultAddress = getVaultAddress(parameters.tokenAddress);

      // Deposit USDC into vault
      await walletClient.sendTransaction({
        to: vaultAddress,
        abi: IC_VAULT_ABI,
        functionName: 'deposit',
        args: [parameters.tokenAmount, walletClient.getAddress()],
      });

      // Step 2: Open Trove with ic-token
      // Approve ic-token if needed
      await walletClient.sendTransaction({
        to: vaultAddress,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [BORROWER_ADDRESS, parameters.tokenAmount],
      });
      // Calculate hints first
      const { upperHint, lowerHint } = await this.getHints(
        walletClient,
        vaultAddress,
        BigInt(parameters.tokenAmount),
        BigInt(parameters.iUSDAmount),
      );
      // Prepare openTrove parameters
      const openTroveParams = {
        _collateral: vaultAddress,
        _collateralAmount: parameters.tokenAmount,
        _maxFeePercentage: BigInt('5000000000000000'),
        _iUSDAmount: BigInt(parameters.iUSDAmount),
        _upperHint: upperHint as `0x${string}`,
        _lowerHint: lowerHint as `0x${string}`,
      };

      // Execute openTrove transaction
      const txHash = await walletClient.sendTransaction({
        to: BORROWER_ADDRESS as `0x${string}`,
        abi: BORROWER_ABI,
        functionName: 'openTrove',
        args: [
          openTroveParams._collateral,
          openTroveParams._collateralAmount,
          openTroveParams._maxFeePercentage,
          openTroveParams._iUSDAmount,
          openTroveParams._upperHint,
          openTroveParams._lowerHint,
        ],
      });

      return `Successfully deposited ${parameters.tokenAmount} USDC into ic-USDC vault and borrowed ${parameters.iUSDAmount} iUSD. Transaction: ${txHash.hash}`;
    } catch (error) {
      throw Error(`Failed to borrow iUSD: ${error}`);
    }
  }

  @Tool({
    name: 'repay_iusd_ironclad',
    description: 'Repay all iUSD and close the Trove position',
  })
  async repayIUSD(
    walletClient: EVMWalletClient,
    parameters: RepayIUSDParameters,
  ): Promise<string> {
    try {
      const vaultAddress = getVaultAddress(parameters.tokenAddress);

      // First, we need to get the total debt of the Trove
      const troveDebtResult = await walletClient.read({
        address: TROVE_MANAGER_ADDRESS as `0x${string}`,
        abi: TROVE_MANAGER_ABI,
        functionName: 'getTroveDebt',
        args: [walletClient.getAddress(), vaultAddress],
      });
      const totalDebt = (troveDebtResult as { value: bigint }).value;

      // LUSD_GAS_COMPENSATION is typically 10 * 10^18 (10 iUSD)
      const LUSD_GAS_COMPENSATION = BigInt('10000000000000000000'); // 10 iUSD in wei
      const actualDebt = totalDebt - LUSD_GAS_COMPENSATION;

      // Check and handle iUSD allowance
      const allowance = await walletClient.read({
        address: IUSD_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [walletClient.getAddress(), BORROWER_ADDRESS],
      });

      if (Number(allowance) < Number(actualDebt)) {
        await walletClient.sendTransaction({
          to: IUSD_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [BORROWER_ADDRESS, actualDebt],
        });
      }

      // Close Trove
      // Close position on the trove
      const txHash = await walletClient.sendTransaction({
        to: BORROWER_ADDRESS,
        abi: BORROWER_ABI,
        functionName: 'closeTrove',
        args: [vaultAddress],
      });

      // Check collateral balance
      const collateralBalanceResult = await walletClient.read({
        address: vaultAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletClient.getAddress()],
      });
      const collateralBalance = (collateralBalanceResult as { value: bigint })
        .value;

      if (collateralBalance > 0n) {
        // Withdraw all collateral
        await walletClient.sendTransaction({
          to: vaultAddress,
          abi: IC_VAULT_ABI,
          functionName: 'withdraw',
          args: [collateralBalance],
        });
      }

      return txHash.hash;
    } catch (error) {
      throw Error(`Failed to close Trove: ${error}`);
    }
  }

  @Tool({
    name: 'monitor_position_ironclad',
    description: 'Monitor health of a Trove position',
  })
  async monitorPosition(
    walletClient: EVMWalletClient,
    parameters: MonitorPositionParameters,
  ): Promise<{
    currentCollateral: string;
    currentDebt: string;
    troveStatus: string;
  }> {
    try {
      const vaultAddress = getVaultAddress(parameters.tokenAddress);
      // Get Trove status
      const statusResult = await walletClient.read({
        address: TROVE_MANAGER_ADDRESS as `0x${string}`,
        abi: TROVE_MANAGER_ABI,
        functionName: 'getTroveStatus',
        args: [walletClient.getAddress(), vaultAddress],
      });
      const status = Number((statusResult as { value: bigint }).value);

      // Get Trove collateral
      const collateralResult = await walletClient.read({
        address: TROVE_MANAGER_ADDRESS as `0x${string}`,
        abi: TROVE_MANAGER_ABI,
        functionName: 'getTroveColl',
        args: [walletClient.getAddress(), vaultAddress],
      });
      const collateral = (collateralResult as { value: bigint }).value;

      // Get Trove debt
      const debtResult = await walletClient.read({
        address: TROVE_MANAGER_ADDRESS as `0x${string}`,
        abi: TROVE_MANAGER_ABI,
        functionName: 'getTroveDebt',
        args: [walletClient.getAddress(), vaultAddress],
      });
      const debt = (debtResult as { value: bigint }).value;

      // Map status number to string
      const statusMap = {
        0: 'nonExistent',
        1: 'active',
        2: 'closedByOwner',
        3: 'closedByLiquidation',
        4: 'closedByRedemption',
      };

      return {
        currentCollateral: collateral.toString(),
        currentDebt: formatUnits(debt, 18),
        troveStatus: statusMap[status as keyof typeof statusMap] || 'unknown',
      };
    } catch (error) {
      throw Error(`Failed to monitor position: ${error}`);
    }
  }

  @Tool({
    name: 'calculate_max_withdrawable_ironclad',
    description:
      'Calculate maximum withdrawable amount while maintaining health factor',
  })
  async calculateMaxWithdrawableAmount(
    walletClient: EVMWalletClient,
    parameters: CalculateMaxWithdrawableParameters,
  ): Promise<bigint> {
    try {
      console.log('\n=== Calculating Max Withdrawable Amount ===');
      const asset = parameters.assetAddress;

      // Get token decimals
      const decimalsResult = await walletClient.read({
        address: asset as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      });
      const decimals = Number((decimalsResult as { value: number }).value);
      console.log('Token Decimals:', decimals);

      // Get user's reserve data
      const userReserveDataResult = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData',
        args: [asset, walletClient.getAddress()],
      });

      const userReserveData = userReserveDataResult.value as [
        bigint,
        bigint,
        bigint,
      ];
      console.log('User Reserve Data:', {
        aTokenBalance: formatUnits(userReserveData[0], decimals),
        stableDebt: formatUnits(userReserveData[1], decimals),
        variableDebt: formatUnits(userReserveData[2], decimals),
      });

      // Get reserve configuration
      const reserveConfigResult = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getReserveConfigurationData',
        args: [asset],
      });

      const reserveConfig = reserveConfigResult.value as [
        bigint,
        bigint,
        bigint,
      ];
      console.log('Reserve Config:', {
        ltv: `${Number(reserveConfig[1]) / 100}%`,
        liquidationThreshold: `${Number(reserveConfig[2]) / 100}%`,
      });

      const currentATokenBalance = userReserveData[0]; // Current collateral
      const currentVariableDebt = userReserveData[2]; // Current debt
      const liquidationThreshold = reserveConfig[2]; // In basis points (e.g., 8500 = 85%)

      console.log('Current State:', {
        balance: formatUnits(currentATokenBalance, decimals),
        debt: formatUnits(currentVariableDebt, decimals),
        threshold: `${Number(liquidationThreshold) / 100}%`,
      });

      if (currentVariableDebt === 0n) {
        console.log(
          'No debt, can withdraw full balance:',
          formatUnits(currentATokenBalance, decimals),
        );
        return currentATokenBalance; // Can withdraw everything if no debt
      }

      // To maintain HF >= 1, we need:
      // (collateral * liquidationThreshold) / debt >= 1
      // So: collateral >= debt / (liquidationThreshold/10000)
      const minRequiredCollateral =
        (currentVariableDebt * 10000n) / liquidationThreshold;
      console.log(
        'Minimum Required Collateral:',
        formatUnits(minRequiredCollateral, decimals),
      );

      if (currentATokenBalance <= minRequiredCollateral) {
        console.log('Cannot withdraw: balance <= required collateral');
        return 0n; // Cannot withdraw anything
      }

      const maxWithdrawable = currentATokenBalance - minRequiredCollateral;
      console.log(
        'Max Withdrawable Amount:',
        formatUnits(maxWithdrawable, decimals),
      );

      return maxWithdrawable;
    } catch (error) {
      console.error('Error calculating max withdrawable amount:', error);
      throw error;
    }
  }

  private async getHints(
    walletClient: EVMWalletClient,
    collateral: string,
    collateralAmount: bigint,
    debt: bigint,
  ): Promise<{ upperHint: string; lowerHint: string }> {
    const decimals = (
      await walletClient.read({
        address: collateral,
        abi: ERC20_ABI,
        functionName: 'decimals',
      })
    ).value;

    const troveCount = (
      await walletClient.read({
        address: TROVE_MANAGER_ADDRESS,
        abi: TROVE_MANAGER_ABI,
        functionName: 'getTroveOwnersCount',
        args: [collateral],
      })
    ).value;

    const numTrials = Math.ceil(15 * Math.sqrt(Number(troveCount)));
    const NICR = (
      await walletClient.read({
        address: HINT_HELPERS_ADDRESS,
        abi: HINT_HELPERS_ABI,
        functionName: 'computeNominalCR',
        args: [collateralAmount, debt, decimals],
      })
    ).value;

    const randomSeed = Math.floor(Math.random() * 1000000);

    const result = await walletClient.read({
      address: HINT_HELPERS_ADDRESS,
      abi: HINT_HELPERS_ABI,
      functionName: 'getApproxHint',
      args: [collateral, NICR, numTrials, randomSeed],
    });

    // The function returns (address hintAddress, uint diff, uint latestRandomSeed)
    const [hintAddress] = (result as { value: [`0x${string}`, bigint, bigint] })
      .value;

    return {
      upperHint: hintAddress,
      lowerHint: '0x0000000000000000000000000000000000000000', // zero address
    };
  }

  @Tool({
    name: 'get_ic_vault_ironclad',
    description:
      'Get the corresponding ic-vault address for a token. Use this before approving tokens for deposit.',
  })
  async getIcVault(
    walletClient: EVMWalletClient,
    parameters: GetIcVaultParameters,
  ): Promise<string> {
    try {
      const vaultAddress = getVaultAddress(parameters.tokenAddress);

      return vaultAddress;
    } catch (error) {
      throw Error(`Failed to get ic-vault address: ${error}`);
    }
  }

  @Tool({
    name: 'get_borrower_address_ironclad',
    description:
      'Get the Borrower contract address. Use this before approving ic-tokens to deposit into Borrow contract to get iUSD.',
  })
  async getBorrowerAddress(
    walletClient: EVMWalletClient,
    parameters: GetBorrowerAddressParameters,
  ): Promise<string> {
    try {
      return BORROWER_ADDRESS;
    } catch (error) {
      throw Error(`Failed to get borrower address: ${error}`);
    }
  }

  @Tool({
    name: 'get_lending_pool_address_ironclad',
    description:
      'Get the Lending Pool contract address. Use this address to approve tokens for looped deposit.',
  })
  async getLendingPoolAddress(
    walletClient: EVMWalletClient,
    parameters: GetLendingPoolAddressParameters,
  ): Promise<string> {
    try {
      return LENDING_POOL_ADDRESS;
    } catch (error) {
      throw Error(`Failed to get lending pool address: ${error}`);
    }
  }

  @Tool({
    name: 'deposit_ironclad',
    description:
      'Deposit an asset into Ironclad lending pool. Make sure to check the address of the concerned token in the current network',
  })
  async deposit(
    walletClient: EVMWalletClient,
    parameters: DepositParameters,
  ): Promise<string> {
    try {
      console.log('📥 Starting deposit process...');
      console.log('Parameters:', {
        asset: parameters.assetAddress,
        amount: parameters.amount,
        referralCode: parameters.referralCode,
      });

      // First approve the lending pool to spend tokens
      console.log('🔓 Approving tokens...');
      const approvalTx = await walletClient.sendTransaction({
        to: parameters.assetAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [LENDING_POOL_ADDRESS, parameters.amount],
      });
      console.log('✅ Approval transaction:', approvalTx.hash);

      // Execute deposit
      console.log('💰 Executing deposit...');
      const depositTx = await walletClient.sendTransaction({
        to: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: 'deposit',
        args: [
          parameters.assetAddress,
          parameters.amount,
          walletClient.getAddress(),
          parameters.referralCode,
        ],
      });

      console.log('✅ Deposit successful!');
      return depositTx.hash;
    } catch (error) {
      console.error('❌ Deposit failed:', error);
      throw Error(`Failed to deposit: ${error}`);
    }
  }

  @Tool({
    name: 'borrow_ironclad',
    description:
      'Borrow an asset from Ironclad lending pool. Make sure to check the address of the concerned token in the current network',
  })
  async borrow(
    walletClient: EVMWalletClient,
    parameters: BorrowParameters,
  ): Promise<string> {
    try {
      console.log('📤 Starting borrow process...');
      console.log('Parameters:', {
        asset: parameters.assetAddress,
        amount: parameters.amount,
        interestRateMode: parameters.interestRateMode,
      });

      const borrowTx = await walletClient.sendTransaction({
        to: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: 'borrow',
        args: [
          parameters.assetAddress,
          parameters.amount,
          parameters.interestRateMode,
          parameters.referralCode,
          walletClient.getAddress(),
        ],
      });

      console.log('✅ Borrow successful!');
      return borrowTx.hash;
    } catch (error) {
      console.error('❌ Borrow failed:', error);
      throw Error(`Failed to borrow: ${error}`);
    }
  }

  @Tool({
    name: 'withdraw_ironclad',
    description:
      'Withdraw an asset from Ironclad lending pool. If no amount specified, withdraws full balance.',
  })
  async withdraw(
    walletClient: EVMWalletClient,
    parameters: WithdrawParameters,
  ): Promise<string> {
    try {
      console.log('💸 Starting withdrawal process...');

      // Get full balance if amount not specified
      let withdrawAmount = parameters.amount;
      if (!withdrawAmount) {
        console.log('Amount not specified, fetching full balance...');
        const userReserveData = await walletClient.read({
          address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
          abi: PROTOCOL_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [parameters.assetAddress, walletClient.getAddress()],
        });
        withdrawAmount = (userReserveData as any).value[0].toString(); // aToken balance
        console.log('Full balance to withdraw:', withdrawAmount);
      }

      console.log('Parameters:', {
        asset: parameters.assetAddress,
        amount: withdrawAmount,
      });

      const withdrawTx = await walletClient.sendTransaction({
        to: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: 'withdraw',
        args: [
          parameters.assetAddress,
          withdrawAmount,
          walletClient.getAddress(),
        ],
      });

      console.log('✅ Withdrawal successful!');
      return withdrawTx.hash;
    } catch (error) {
      console.error('❌ Withdrawal failed:', error);
      throw Error(`Failed to withdraw: ${error}`);
    }
  }

  @Tool({
    name: 'repay_ironclad',
    description:
      'Repay borrowed assets to Ironclad lending pool. If no amount specified, repays full debt.',
  })
  async repay(
    walletClient: EVMWalletClient,
    parameters: RepayParameters,
  ): Promise<string> {
    try {
      console.log('💰 Starting repayment process...');

      // Get current debt if amount not specified
      let repayAmount = parameters.amount;
      if (!repayAmount) {
        console.log('Amount not specified, fetching current debt...');
        const userReserveData = await walletClient.read({
          address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
          abi: PROTOCOL_DATA_PROVIDER_ABI,
          functionName: 'getUserReserveData',
          args: [parameters.assetAddress, walletClient.getAddress()],
        });
        repayAmount = (userReserveData as any).value[2].toString(); // variableDebt
        console.log('Current debt to repay:', repayAmount);
      }

      console.log('Parameters:', {
        asset: parameters.assetAddress,
        amount: repayAmount,
        interestRateMode: parameters.interestRateMode,
      });

      // First approve the lending pool to spend tokens
      console.log('🔓 Approving tokens for repayment...');
      const approvalTx = await walletClient.sendTransaction({
        to: parameters.assetAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [LENDING_POOL_ADDRESS, repayAmount],
      });
      console.log('✅ Approval transaction:', approvalTx.hash);

      const repayTx = await walletClient.sendTransaction({
        to: LENDING_POOL_ADDRESS,
        abi: LENDING_POOL_ABI,
        functionName: 'repay',
        args: [
          parameters.assetAddress,
          repayAmount,
          parameters.interestRateMode,
          walletClient.getAddress(),
        ],
      });

      console.log('✅ Repayment successful!');
      return repayTx.hash;
    } catch (error) {
      console.error('❌ Repayment failed:', error);
      throw Error(`Failed to repay: ${error}`);
    }
  }

  @Tool({
    name: 'monitor_lending_position_ironclad',
    description: 'Monitor a lending position in Ironclad',
  })
  async monitorLendingPosition(
    walletClient: EVMWalletClient,
    parameters: MonitorLendingPositionParameters,
  ): Promise<{
    deposited: string;
    borrowed: string;
    healthFactor: string;
    currentLTV: string;
    availableToBorrow: string;
  }> {
    try {
      console.log('\n=== Monitoring Lending Position ===');
      console.log('Asset Address:', parameters.assetAddress);
      console.log('User Address:', walletClient.getAddress());

      // Get token decimals first
      const decimalsResult = await walletClient.read({
        address: parameters.assetAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      });
      const decimals = Number((decimalsResult as { value: number }).value);
      const decimalsBigInt = BigInt(10 ** decimals);
      console.log('Token Decimals:', decimals);

      // Get user's reserve data
      console.log('\n--- Fetching User Reserve Data ---');
      const userReserveData = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getUserReserveData',
        args: [parameters.assetAddress, walletClient.getAddress()],
      });

      // Get reserve configuration
      console.log('\n--- Fetching Reserve Configuration ---');
      const reserveConfig = await walletClient.read({
        address: PROTOCOL_DATA_PROVIDER_ADDRESS as `0x${string}`,
        abi: PROTOCOL_DATA_PROVIDER_ABI,
        functionName: 'getReserveConfigurationData',
        args: [parameters.assetAddress],
      });

      // Parse the data
      const deposited = (userReserveData as any).value[0];
      const borrowed = (userReserveData as any).value[2];
      const ltv = Number((reserveConfig as any).value[1]) / 10000; // Convert basis points to percentage

      console.log('\n--- Position Details ---');
      console.log('Raw Deposited:', deposited.toString());
      console.log('Raw Borrowed:', borrowed.toString());
      console.log('LTV Ratio:', `${(ltv * 100).toFixed(2)}%`);

      // Calculate health factor and current LTV
      const healthFactor =
        borrowed === 0n
          ? '∞'
          : ((Number(deposited) * ltv) / Number(borrowed)).toFixed(2);

      const currentLTV =
        borrowed === 0n
          ? '0'
          : ((Number(borrowed) / Number(deposited)) * 100).toFixed(2);

      console.log('\n--- Risk Metrics ---');
      console.log('Health Factor:', healthFactor);
      console.log('Current LTV:', `${currentLTV}%`);

      // Calculate available to borrow
      const maxBorrow = BigInt(Math.floor(Number(deposited) * ltv)); // Round down to avoid floating point
      const availableToBorrow =
        maxBorrow > borrowed
          ? ((maxBorrow - borrowed) / decimalsBigInt).toString()
          : '0';

      console.log('\n--- Borrowing Capacity ---');
      console.log('Max Borrowable:', formatUnits(maxBorrow, decimals));
      console.log('Available to Borrow:', availableToBorrow);

      console.log('\n--- Formatted Position Summary ---');
      console.log('Deposited:', formatUnits(deposited, decimals));
      console.log('Borrowed:', formatUnits(borrowed, decimals));
      console.log('Health Factor:', healthFactor);
      console.log('Current LTV:', `${currentLTV}%`);
      console.log('Available to Borrow:', availableToBorrow);

      console.log('\n=== Position Monitoring Complete ===');

      return {
        deposited: (deposited / decimalsBigInt).toString(),
        borrowed: (borrowed / decimalsBigInt).toString(),
        healthFactor,
        currentLTV: `${currentLTV}%`,
        availableToBorrow,
      };
    } catch (error) {
      console.error('\n❌ Error Monitoring Position ❌');
      console.error('Error Details:', error);
      throw Error(`Failed to monitor lending position: ${error}`);
    }
  }
}
