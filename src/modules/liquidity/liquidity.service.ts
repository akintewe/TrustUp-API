import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { SupabaseService } from '../../database/supabase.client';
import { LiquidityContractClient } from '../../blockchain/contracts/liquidity-contract.client';
import { InvestmentSummaryResponseDto } from './dto/investment-summary-response.dto';

/** Redis cache TTL for investment summary: 60 seconds */
const SUMMARY_CACHE_TTL = 60;

/** Stroops per token unit (Stellar uses 7 decimal places) */
const STROOPS = 10_000_000;

/**
 * Basis points divisor used by the contract for share_price.
 * share_price = (total_liquidity × 10_000) / total_shares
 * so 10_000 = par (1.00).
 */
const SHARE_PRICE_BPS = 10_000n;

/**
 * LP fee share: 85% of pool interest goes to LPs (contract constant LP_FEE_BPS = 8500).
 * Used to estimate APY from the average loan interest rate.
 */
const LP_FEE_RATIO = 0.85;

@Injectable()
export class LiquidityService {
  private readonly logger = new Logger(LiquidityService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly supabaseService: SupabaseService,
    private readonly liquidityClient: LiquidityContractClient,
  ) {}

  /**
   * Returns a comprehensive investment summary for the authenticated user.
   *
   * Data sources:
   *  - Contract `get_lp_shares`:        user's raw share balance
   *  - Contract `calculate_withdrawal`:  current token value of those shares
   *  - Contract `get_pool_stats`:        total_liquidity (pool size) and share_price
   *  - DB `liquidity_positions`:         historical deposited_amount (totalInvested)
   *  - DB `loans` (active):              activeLoans count + weighted-average APY estimate
   *
   * APY is not exposed by the contract, so it is estimated as:
   *   weighted_avg_interest_rate_of_active_loans × 85% (LP fee share)
   *
   * Caching: Redis with 60-second TTL keyed by wallet address.
   * Users with zero shares receive a valid zero-value response.
   *
   * @param wallet - Authenticated user's Stellar wallet address
   */
  async getInvestmentSummary(wallet: string): Promise<InvestmentSummaryResponseDto> {
    const cacheKey = `liquidity:summary:${wallet}`;

    const cached = await this.cacheManager.get<InvestmentSummaryResponseDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT for ${wallet.slice(0, 8)}...`);
      return cached;
    }

    this.logger.debug(`Cache MISS for ${wallet.slice(0, 8)}... — fetching from sources`);

    // Fan out independent reads in parallel
    const [sharesInStroops, poolStats, totalInvested, { activeLoans, estimatedApy }] =
      await Promise.all([
        this.liquidityClient.getLpShares(wallet),
        this.liquidityClient.getPoolStats(),
        this.getTotalInvested(wallet),
        this.getActiveLoansStats(),
      ]);

    // calculate_withdrawal requires the share amount — call after shares resolve
    const currentValueInStroops =
      sharesInStroops > 0n
        ? await this.liquidityClient.calculateWithdrawal(sharesInStroops)
        : 0n;

    const shares = Number(sharesInStroops) / STROOPS;
    const currentValue = Number(currentValueInStroops) / STROOPS;
    const poolSize = Number(poolStats.totalLiquidity) / STROOPS;

    const earnings = Math.round((currentValue - totalInvested) * STROOPS) / STROOPS;
    const earningsPercent =
      totalInvested > 0 ? Math.round((earnings / totalInvested) * 10000) / 100 : 0;

    const summary: InvestmentSummaryResponseDto = {
      totalInvested,
      currentValue,
      earnings,
      earningsPercent,
      apy: estimatedApy,
      poolSize,
      activeLoans,
      shares,
    };

    await this.cacheManager.set(cacheKey, summary, SUMMARY_CACHE_TTL);

    return summary;
  }

  /**
   * Retrieves the user's historical total deposited amount from the database.
   * Returns 0 if the user has never deposited.
   */
  private async getTotalInvested(wallet: string): Promise<number> {
    const client = this.supabaseService.getServiceRoleClient();

    const { data, error } = await client
      .from('liquidity_positions')
      .select('deposited_amount')
      .eq('provider_wallet', wallet)
      .single();

    if (error || !data) {
      return 0;
    }

    return Number(data.deposited_amount);
  }

  /**
   * Counts active loans and estimates pool APY from their interest rates.
   *
   * APY estimate = weighted average interest rate of active loans × LP_FEE_RATIO (85%).
   *
   * This reflects the share of interest income the contract routes to LPs via
   * `distribute_interest` (LP_FEE_BPS = 8500 out of 10_000).
   *
   * Returns 0 for both when there are no active loans (pool is new or empty).
   */
  private async getActiveLoansStats(): Promise<{ activeLoans: number; estimatedApy: number }> {
    const client = this.supabaseService.getServiceRoleClient();

    const { data, error } = await client
      .from('loans')
      .select('loan_amount, interest_rate')
      .eq('status', 'active');

    if (error || !data || data.length === 0) {
      if (error) {
        this.logger.warn(`Failed to fetch active loans for APY: ${error.message}`);
      }
      return { activeLoans: 0, estimatedApy: 0 };
    }

    const activeLoans = data.length;

    // Weighted average interest rate by loan_amount
    const totalAmount = data.reduce((sum, l) => sum + Number(l.loan_amount), 0);
    const weightedRate =
      totalAmount > 0
        ? data.reduce(
            (sum, l) => sum + Number(l.interest_rate) * (Number(l.loan_amount) / totalAmount),
            0,
          )
        : 0;

    const estimatedApy = Math.round(weightedRate * LP_FEE_RATIO * 100) / 100;

    return { activeLoans, estimatedApy };
  }
}
