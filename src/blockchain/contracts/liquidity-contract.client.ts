import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from 'stellar-sdk';
import { SorobanService } from '../soroban/soroban.service';

export interface PoolStats {
  /** Total token balance in the pool (stroops) */
  totalLiquidity: bigint;
  /** Tokens currently lent out and not yet repaid (stroops) */
  lockedLiquidity: bigint;
  /** Tokens available for new loans (stroops) */
  availableLiquidity: bigint;
  /** Total shares outstanding (stroops) */
  totalShares: bigint;
  /**
   * Share price in basis points: (total_liquidity × 10_000) / total_shares.
   * 10_000 = par (1.00). 10_850 means each share is worth 1.085 tokens.
   */
  sharePrice: bigint;
}

/**
 * TypeScript client for the on-chain LiquidityPool smart contract.
 *
 * Contract query methods (read-only, no signing required):
 *   - get_lp_shares(provider: Address) -> i128
 *   - get_pool_stats()                 -> PoolStats
 *   - calculate_withdrawal(shares: i128) -> i128
 *
 * All i128 amounts are in stroops (7 decimal places, divide by 10_000_000
 * to get human-readable token units).
 */
@Injectable()
export class LiquidityContractClient {
  private readonly logger = new Logger(LiquidityContractClient.name);
  private readonly contractId: string;

  constructor(
    private readonly sorobanService: SorobanService,
    private readonly configService: ConfigService,
  ) {
    this.contractId = this.configService.get<string>('LIQUIDITY_CONTRACT_ID') || '';

    if (this.contractId) {
      this.logger.log(`Liquidity contract loaded: ${this.contractId.slice(0, 8)}...`);
    } else {
      this.logger.warn('LIQUIDITY_CONTRACT_ID is not set — contract calls will fail');
    }
  }

  /**
   * Returns the raw share balance (i128 in stroops) for a liquidity provider.
   * Calls `get_lp_shares(provider: Address) -> i128`.
   *
   * @param wallet - Stellar public key (G... format)
   * @returns Shares in stroops (divide by 10_000_000 for human-readable units)
   */
  async getLpShares(wallet: string): Promise<bigint> {
    this.ensureConfigured();

    const addressArg = StellarSdk.nativeToScVal(
      StellarSdk.Address.fromString(wallet),
      { type: 'address' },
    );

    try {
      const result = await this.sorobanService.simulateContractCall(
        this.contractId,
        'get_lp_shares',
        [addressArg],
      );

      const raw = StellarSdk.scValToNative(result);
      return raw !== undefined && raw !== null ? BigInt(raw) : 0n;
    } catch (error) {
      // Contract returns an error when the wallet has no entry — treat as zero
      if (
        error.message?.includes('HostError') ||
        error.message?.includes('Status(ContractError')
      ) {
        this.logger.debug(`No LP shares for wallet ${wallet.slice(0, 8)}...`);
        return 0n;
      }
      this.logger.error(`getLpShares failed for ${wallet.slice(0, 8)}...: ${error.message}`);
      throw new ServiceUnavailableException({
        code: 'BLOCKCHAIN_CONTRACT_UNAVAILABLE',
        message: 'Liquidity contract is temporarily unavailable. Please try again later.',
      });
    }
  }

  /**
   * Returns aggregate pool statistics.
   * Calls `get_pool_stats() -> PoolStats`.
   *
   * PoolStats fields (all i128 in stroops, except share_price in basis points):
   *   total_liquidity, locked_liquidity, available_liquidity, total_shares, share_price
   */
  async getPoolStats(): Promise<PoolStats> {
    this.ensureConfigured();

    try {
      const result = await this.sorobanService.simulateContractCall(
        this.contractId,
        'get_pool_stats',
        [],
      );

      // scValToNative converts the Soroban struct (ScMap) to a plain JS object
      // with snake_case keys matching the Rust field names.
      const raw = StellarSdk.scValToNative(result) as Record<string, unknown>;

      return {
        totalLiquidity: BigInt(raw['total_liquidity'] as string | number | bigint),
        lockedLiquidity: BigInt(raw['locked_liquidity'] as string | number | bigint),
        availableLiquidity: BigInt(raw['available_liquidity'] as string | number | bigint),
        totalShares: BigInt(raw['total_shares'] as string | number | bigint),
        sharePrice: BigInt(raw['share_price'] as string | number | bigint),
      };
    } catch (error) {
      this.logger.error(`getPoolStats failed: ${error.message}`);
      throw new ServiceUnavailableException({
        code: 'BLOCKCHAIN_CONTRACT_UNAVAILABLE',
        message: 'Liquidity contract is temporarily unavailable. Please try again later.',
      });
    }
  }

  /**
   * Calculates the token value of a given share amount at the current pool price.
   * Calls `calculate_withdrawal(shares: i128) -> i128`.
   *
   * Formula (on-chain): `(shares × total_liquidity) / total_shares`
   *
   * @param sharesInStroops - Raw share amount in stroops (as returned by getLpShares)
   * @returns Token value in stroops
   */
  async calculateWithdrawal(sharesInStroops: bigint): Promise<bigint> {
    this.ensureConfigured();

    const sharesArg = StellarSdk.nativeToScVal(sharesInStroops, { type: 'i128' });

    try {
      const result = await this.sorobanService.simulateContractCall(
        this.contractId,
        'calculate_withdrawal',
        [sharesArg],
      );

      const raw = StellarSdk.scValToNative(result);
      return raw !== undefined && raw !== null ? BigInt(raw) : 0n;
    } catch (error) {
      this.logger.error(`calculateWithdrawal failed: ${error.message}`);
      throw new ServiceUnavailableException({
        code: 'BLOCKCHAIN_CONTRACT_UNAVAILABLE',
        message: 'Liquidity contract is temporarily unavailable. Please try again later.',
      });
    }
  }

  private ensureConfigured(): void {
    if (!this.contractId) {
      throw new ServiceUnavailableException({
        code: 'BLOCKCHAIN_CONTRACT_NOT_CONFIGURED',
        message: 'Liquidity contract is not configured. Please contact support.',
      });
    }
  }
}
