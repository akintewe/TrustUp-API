import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { SupabaseService } from '../../database/supabase.client';
import { LiquidityContractClient } from '../../blockchain/contracts/liquidity-contract.client';
import { InvestmentSummaryResponseDto } from './dto/investment-summary-response.dto';
import { LiquidityWithdrawRequestDto } from './dto/liquidity-withdraw-request.dto';
import { LiquidityWithdrawResponseDto } from './dto/liquidity-withdraw-response.dto';

const SUMMARY_CACHE_TTL = 60;
const STROOPS = 10_000_000n;
const SHARE_PRICE_BPS = 10_000n;
const LP_FEE_RATIO = 0.85;

@Injectable()
export class LiquidityService {
  private readonly logger = new Logger(LiquidityService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly supabaseService: SupabaseService,
    private readonly liquidityClient: LiquidityContractClient,
  ) {}

  async getInvestmentSummary(wallet: string): Promise<InvestmentSummaryResponseDto> {
    const cacheKey = `liquidity:summary:${wallet}`;

    const cached = await this.cacheManager.get<InvestmentSummaryResponseDto>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT for ${wallet.slice(0, 8)}...`);
      return cached;
    }

    this.logger.debug(`Cache MISS for ${wallet.slice(0, 8)}... - fetching from sources`);

    const [sharesInStroops, poolStats, totalInvested, { activeLoans, estimatedApy }] =
      await Promise.all([
        this.liquidityClient.getLpShares(wallet),
        this.liquidityClient.getPoolStats(),
        this.getTotalInvested(wallet),
        this.getActiveLoansStats(),
      ]);

    const currentValueInStroops =
      sharesInStroops > 0n
        ? await this.liquidityClient.calculateWithdrawal(sharesInStroops)
        : 0n;

    const shares = this.fromStroops(sharesInStroops);
    const currentValue = this.fromStroops(currentValueInStroops);
    const poolSize = this.fromStroops(poolStats.totalLiquidity);

    const earnings = this.roundTo7(currentValue - totalInvested);
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

  async withdrawLiquidity(
    wallet: string,
    dto: LiquidityWithdrawRequestDto,
  ): Promise<LiquidityWithdrawResponseDto> {
    const requestedShares = this.toStroops(dto.shares);

    if (requestedShares <= 0n) {
      throw new BadRequestException({
        code: 'VALIDATION_INVALID_SHARES',
        message: 'Withdrawal shares must be greater than zero.',
      });
    }

    const [ownedShares, poolStats] = await Promise.all([
      this.liquidityClient.getLpShares(wallet),
      this.liquidityClient.getPoolStats(),
    ]);

    if (ownedShares <= 0n || requestedShares > ownedShares) {
      throw new BadRequestException({
        code: 'LIQUIDITY_INSUFFICIENT_SHARES',
        message: 'You do not have enough pool shares to complete this withdrawal.',
      });
    }

    const expectedAmount = await this.liquidityClient.calculateWithdrawal(requestedShares);

    if (expectedAmount > poolStats.availableLiquidity) {
      throw new HttpException(
        {
          code: 'LIQUIDITY_INSUFFICIENT_AVAILABLE_LIQUIDITY',
          message:
            'The pool does not currently have enough liquid funds to satisfy this withdrawal. Please try a smaller amount or wait for liquidity to free up.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    const fee = (expectedAmount * poolStats.withdrawalFeeBps) / SHARE_PRICE_BPS;
    const netAmount = expectedAmount - fee;
    const remainingShares = ownedShares - requestedShares;
    const unsignedXdr = await this.liquidityClient.buildWithdrawTx(wallet, requestedShares);

    return {
      unsignedXdr,
      description: `Withdraw ${this.formatDisplayNumber(requestedShares)} shares from liquidity pool`,
      preview: {
        shares: this.fromStroops(requestedShares),
        ownedShares: this.fromStroops(ownedShares),
        remainingShares: this.fromStroops(remainingShares),
        currentSharePrice: this.roundTo7(Number(poolStats.sharePrice) / Number(SHARE_PRICE_BPS)),
        expectedAmount: this.fromStroops(expectedAmount),
        feeBps: Number(poolStats.withdrawalFeeBps),
        fee: this.fromStroops(fee),
        netAmount: this.fromStroops(netAmount),
        availableLiquidity: this.fromStroops(poolStats.availableLiquidity),
      },
    };
  }

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
    const totalAmount = data.reduce((sum, loan) => sum + Number(loan.loan_amount), 0);
    const weightedRate =
      totalAmount > 0
        ? data.reduce(
            (sum, loan) =>
              sum + Number(loan.interest_rate) * (Number(loan.loan_amount) / totalAmount),
            0,
          )
        : 0;

    return {
      activeLoans,
      estimatedApy: Math.round(weightedRate * LP_FEE_RATIO * 100) / 100,
    };
  }

  private toStroops(value: number): bigint {
    return BigInt(Math.round(value * Number(STROOPS)));
  }

  private fromStroops(value: bigint): number {
    return this.roundTo7(Number(value) / Number(STROOPS));
  }

  private roundTo7(value: number): number {
    return Math.round(value * Number(STROOPS)) / Number(STROOPS);
  }

  private formatDisplayNumber(value: bigint): string {
    const normalized = this.fromStroops(value);
    return Number.isInteger(normalized) ? String(normalized) : normalized.toString();
  }
}
