import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ReputationService } from '../reputation/reputation.service';
import { SupabaseService } from '../../database/supabase.client';
import { CreditLineContractClient } from '../../blockchain/contracts/credit-line-contract.client';
import { ReputationContractClient } from '../../blockchain/contracts/reputation-contract.client';
import { LoanQuoteRequestDto } from './dto/loan-quote-request.dto';
import { LoanQuoteResponseDto, SchedulePaymentDto } from './dto/loan-quote-response.dto';
import { LoanPaymentRequestDto } from './dto/loan-payment-request.dto';
import { LoanPaymentResponseDto } from './dto/loan-payment-response.dto';
import { AvailableCreditResponseDto } from './dto/available-credit-response.dto';
import { ReputationTier } from '../reputation/dto/reputation-response.dto';

/** Guarantee percentage of the total purchase amount */
const GUARANTEE_PERCENT = 0.2;

/** Loan percentage of the total purchase amount (1 - guarantee) */
const LOAN_PERCENT = 0.8;

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly reputationService: ReputationService,
    private readonly supabaseService: SupabaseService,
    private readonly creditLineClient: CreditLineContractClient,
    private readonly reputationContractClient: ReputationContractClient,
  ) {}

  /**
   * Calculates a loan quote based on the user's reputation score and the
   * requested amount/term. No blockchain interaction — purely off-chain math.
   *
   * Steps:
   * 1. Fetch the user's reputation (score, tier, interest rate, max credit)
   * 2. Validate the merchant exists and is active
   * 3. Validate the amount is within the user's credit limit
   * 4. Calculate guarantee, loan amount, interest, and total repayment
   * 5. Generate a monthly repayment schedule
   *
   * @param wallet - Stellar wallet address of the borrower
   * @param dto    - Loan quote request (amount, merchant, term)
   */
  async calculateLoanQuote(
    wallet: string,
    dto: LoanQuoteRequestDto,
  ): Promise<LoanQuoteResponseDto> {
    // 1. Fetch reputation to determine interest rate and credit limit
    const reputation = await this.reputationService.getReputationScore(wallet);

    // 2. Validate merchant exists and is active
    await this.validateMerchant(dto.merchant);

    // 3. Validate amount against user's max credit
    if (dto.amount > reputation.maxCredit) {
      throw new BadRequestException({
        code: 'LOAN_AMOUNT_EXCEEDS_CREDIT',
        message: `Requested amount $${dto.amount} exceeds your maximum credit limit of $${reputation.maxCredit}. Improve your reputation score to unlock higher limits.`,
      });
    }

    // 4. Calculate loan breakdown
    const guarantee = Math.round(dto.amount * GUARANTEE_PERCENT * 100) / 100;
    const loanAmount = Math.round(dto.amount * LOAN_PERCENT * 100) / 100;
    const interestRate = reputation.interestRate;

    // Interest = principal × (rate/100) × (term/12)
    const interest = loanAmount * (interestRate / 100) * (dto.term / 12);
    const totalRepayment = Math.round((loanAmount + interest) * 100) / 100;

    // 5. Generate repayment schedule
    const schedule = this.generateSchedule(totalRepayment, dto.term);

    return {
      amount: dto.amount,
      guarantee,
      loanAmount,
      interestRate,
      totalRepayment,
      term: dto.term,
      schedule,
    };
  }

  /**
   * Processes a loan repayment request. Validates the loan and payment amount,
   * constructs an unsigned Soroban repay_loan() transaction, and returns it
   * alongside a payment preview for the mobile app to review before signing.
   *
   * Steps:
   * 1. Fetch the loan from the database by loanId
   * 2. Validate the loan exists and belongs to the authenticated user
   * 3. Validate the loan is in 'active' status
   * 4. Validate the payment amount is within the remaining balance
   * 5. Build an unsigned repay_loan() XDR transaction via the contract client
   * 6. Calculate the new remaining balance and determine if the loan will complete
   * 7. Return the unsigned XDR and payment preview
   *
   * @param wallet  - Authenticated borrower's Stellar wallet address
   * @param loanId  - UUID of the loan record in the database
   * @param dto     - Payment request containing the amount
   */
  async repayLoan(
    wallet: string,
    loanId: string,
    dto: LoanPaymentRequestDto,
  ): Promise<LoanPaymentResponseDto> {
    const client = this.supabaseService.getServiceRoleClient();

    // 1. Fetch loan from database
    const { data: loan, error } = await client
      .from('loans')
      .select('id, loan_id, user_wallet, status, remaining_balance')
      .eq('id', loanId)
      .single();

    if (error || !loan) {
      throw new NotFoundException({
        code: 'LOAN_NOT_FOUND',
        message: 'Loan not found. Please provide a valid loan ID.',
      });
    }

    // 2. Verify loan ownership
    if (loan.user_wallet !== wallet) {
      throw new NotFoundException({
        code: 'LOAN_NOT_FOUND',
        message: 'Loan not found. Please provide a valid loan ID.',
      });
    }

    // 3. Validate loan status is active
    if (loan.status !== 'active') {
      throw new BadRequestException({
        code: 'LOAN_NOT_ACTIVE',
        message: `Cannot make payments on a loan with status '${loan.status}'. Only active loans can be repaid.`,
      });
    }

    const remainingBalance = Number(loan.remaining_balance);

    // 4. Validate payment amount does not exceed remaining balance
    if (dto.amount > remainingBalance) {
      throw new BadRequestException({
        code: 'LOAN_PAYMENT_EXCEEDS_BALANCE',
        message: `Payment amount $${dto.amount} exceeds the remaining balance of $${remainingBalance}.`,
      });
    }

    // 5. Build unsigned repay_loan() Soroban transaction
    const unsignedXdr = await this.creditLineClient.buildRepayLoanTx(
      wallet,
      loan.loan_id,
      dto.amount,
    );

    // 6. Calculate new balance and completion flag
    const newBalance = Math.round((remainingBalance - dto.amount) * 10_000_000) / 10_000_000;
    const willComplete = newBalance === 0;

    return {
      unsignedXdr,
      preview: {
        paymentAmount: dto.amount,
        currentBalance: remainingBalance,
        newBalance,
        willComplete,
      },
    };
  }

  async getAvailableCredit(wallet: string): Promise<AvailableCreditResponseDto> {
    let reputationScore: number;

    try {
      reputationScore = (await this.reputationContractClient.getScore(wallet)) ?? 0;
    } catch (error) {
      this.logger.error(`Failed to fetch reputation score for ${wallet}: ${error.message}`);
      throw new ServiceUnavailableException({
        code: 'REPUTATION_CONTRACT_UNAVAILABLE',
        message: 'Unable to read the reputation contract right now. Please try again later.',
      });
    }

    const { maxCredit, tier } = this.mapScoreToCreditTier(reputationScore);

    const client = this.supabaseService.getServiceRoleClient();
    const { data: activeLoans, error } = await client
      .from('loans')
      .select('remaining_balance')
      .eq('user_wallet', wallet)
      .eq('status', 'active');

    if (error) {
      throw new InternalServerErrorException({
        code: 'ACTIVE_LOANS_QUERY_FAILED',
        message: 'Failed to calculate active loan utilization.',
      });
    }

    const creditUsed = Math.round(
      (activeLoans ?? []).reduce((sum, loan) => sum + Number(loan.remaining_balance ?? 0), 0) * 100,
    ) / 100;
    const availableCredit = Math.max(0, Math.round((maxCredit - creditUsed) * 100) / 100);

    return {
      reputationScore,
      reputationTier: tier,
      maxCreditLimit: maxCredit,
      creditUsed,
      availableCredit,
      activeLoans: activeLoans?.length ?? 0,
    };
  }

  /**
   * Validates that a merchant exists in the database and is currently active.
   * Throws NotFoundException if the merchant doesn't exist, or
   * BadRequestException if the merchant is inactive.
   */
  private async validateMerchant(merchantId: string): Promise<void> {
    const client = this.supabaseService.getServiceRoleClient();

    const { data: merchant, error } = await client
      .from('merchants')
      .select('id, name, is_active')
      .eq('id', merchantId)
      .single();

    if (error || !merchant) {
      throw new NotFoundException({
        code: 'MERCHANT_NOT_FOUND',
        message: 'Merchant not found. Please provide a valid merchant ID.',
      });
    }

    if (!merchant.is_active) {
      throw new BadRequestException({
        code: 'MERCHANT_INACTIVE',
        message: `Merchant "${merchant.name}" is not currently accepting new loans.`,
      });
    }
  }

  /**
   * Generates an equal-payment monthly repayment schedule.
   * The last payment absorbs any rounding remainder so the sum
   * of all payments equals totalRepayment exactly.
   *
   * @param totalRepayment - Total amount to be repaid
   * @param term           - Number of monthly payments
   */
  generateSchedule(totalRepayment: number, term: number): SchedulePaymentDto[] {
    const monthlyPayment = Math.floor((totalRepayment / term) * 100) / 100;
    const now = new Date();
    const schedule: SchedulePaymentDto[] = [];

    let allocated = 0;

    for (let i = 1; i <= term; i++) {
      const dueDate = new Date(now);
      dueDate.setMonth(dueDate.getMonth() + i);
      dueDate.setHours(0, 0, 0, 0);

      const isLast = i === term;
      const amount = isLast
        ? Math.round((totalRepayment - allocated) * 100) / 100
        : monthlyPayment;

      allocated += amount;

      schedule.push({
        paymentNumber: i,
        amount,
        dueDate: dueDate.toISOString(),
      });
    }

    return schedule;
  }

  private mapScoreToCreditTier(score: number): {
    tier: ReputationTier;
    maxCredit: number;
  } {
    if (score >= 90) {
      return { tier: 'gold', maxCredit: 5000 };
    }

    if (score >= 75) {
      return { tier: 'silver', maxCredit: 3000 };
    }

    if (score >= 60) {
      return { tier: 'bronze', maxCredit: 1500 };
    }

    return { tier: 'poor', maxCredit: 500 };
  }
}
