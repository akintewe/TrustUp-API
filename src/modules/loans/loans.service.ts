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
import { CreateLoanRequestDto } from './dto/create-loan-request.dto';
import { CreateLoanResponseDto } from './dto/create-loan-response.dto';
import { LoanPaymentRequestDto } from './dto/loan-payment-request.dto';
import { LoanPaymentResponseDto } from './dto/loan-payment-response.dto';
import { AvailableCreditResponseDto } from './dto/available-credit-response.dto';
import { ReputationTier } from '../reputation/dto/reputation-response.dto';

const GUARANTEE_PERCENT = 0.2;
const LOAN_PERCENT = 0.8;
const MIN_LOAN_REPUTATION_SCORE = 60;

interface ValidMerchant {
  id: string;
  name: string;
  is_active: boolean;
}

interface CreateLoanRecord {
  loan_id: string;
  user_wallet: string;
  merchant_id: string;
  amount: number;
  loan_amount: number;
  guarantee: number;
  interest_rate: number;
  total_repayment: number;
  remaining_balance: number;
  term: number;
  status: 'pending';
  next_payment_due: string | null;
}

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private readonly reputationService: ReputationService,
    private readonly supabaseService: SupabaseService,
    private readonly creditLineContractClient: CreditLineContractClient,
    private readonly reputationContractClient: ReputationContractClient,
  ) {}

  async calculateLoanQuote(
    wallet: string,
    dto: LoanQuoteRequestDto,
  ): Promise<LoanQuoteResponseDto> {
    const { terms } = await this.prepareLoanPreview(wallet, dto, false);
    return terms;
  }

  async createLoan(wallet: string, dto: CreateLoanRequestDto): Promise<CreateLoanResponseDto> {
    const { merchant, terms } = await this.prepareLoanPreview(wallet, dto, true);
    const loanId = this.generateProvisionalLoanId();
    const description = `Create BNPL loan for $${dto.amount} at ${merchant.name}`;

    let xdr: string;
    try {
      xdr = await this.creditLineContractClient.buildCreateLoanTransaction(wallet, {
        loanId,
        merchantId: merchant.id,
        amount: dto.amount,
        loanAmount: terms.loanAmount,
        guarantee: terms.guarantee,
        interestRate: terms.interestRate,
        term: terms.term,
      });
    } catch (error) {
      this.logger.error(`Failed to build create_loan XDR for ${loanId}: ${error.message}`);
      throw new InternalServerErrorException({
        code: 'BLOCKCHAIN_CREATE_LOAN_XDR_FAILED',
        message: 'Failed to construct unsigned loan transaction. Please try again.',
      });
    }

    try {
      await this.persistPendingLoan({
        loan_id: loanId,
        user_wallet: wallet,
        merchant_id: merchant.id,
        amount: terms.amount,
        loan_amount: terms.loanAmount,
        guarantee: terms.guarantee,
        interest_rate: terms.interestRate,
        total_repayment: terms.totalRepayment,
        remaining_balance: terms.totalRepayment,
        term: terms.term,
        status: 'pending',
        next_payment_due: terms.schedule[0]?.dueDate ?? null,
      });
    } catch (error) {
      this.logger.error(`Failed to persist pending loan ${loanId}: ${error.message}`);
      throw new InternalServerErrorException({
        code: 'DATABASE_CREATE_LOAN_FAILED',
        message: 'Failed to persist pending loan record. Please try again.',
      });
    }

    return {
      loanId,
      xdr,
      description,
      terms,
    };
  }

  async repayLoan(
    wallet: string,
    loanId: string,
    dto: LoanPaymentRequestDto,
  ): Promise<LoanPaymentResponseDto> {
    const client = this.supabaseService.getServiceRoleClient();
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

    if (loan.user_wallet !== wallet) {
      throw new NotFoundException({
        code: 'LOAN_NOT_FOUND',
        message: 'Loan not found. Please provide a valid loan ID.',
      });
    }

    if (loan.status !== 'active') {
      throw new BadRequestException({
        code: 'LOAN_NOT_ACTIVE',
        message: `Cannot make payments on a loan with status '${loan.status}'. Only active loans can be repaid.`,
      });
    }

    const remainingBalance = Number(loan.remaining_balance);
    if (dto.amount > remainingBalance) {
      throw new BadRequestException({
        code: 'LOAN_PAYMENT_EXCEEDS_BALANCE',
        message: `Payment amount $${dto.amount} exceeds the remaining balance of $${remainingBalance}.`,
      });
    }

    const unsignedXdr = await this.creditLineContractClient.buildRepayLoanTx(
      wallet,
      loan.loan_id,
      dto.amount,
    );

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

  private async prepareLoanPreview(
    wallet: string,
    dto: LoanQuoteRequestDto,
    enforceMinimumReputation: boolean,
  ): Promise<{ merchant: ValidMerchant; terms: LoanQuoteResponseDto }> {
    const reputation = await this.reputationService.getReputationScore(wallet);
    const merchant = await this.validateMerchant(dto.merchant);

    if (enforceMinimumReputation && reputation.score < MIN_LOAN_REPUTATION_SCORE) {
      throw new BadRequestException({
        code: 'LOAN_REPUTATION_TOO_LOW',
        message: `Minimum reputation score to create a loan is ${MIN_LOAN_REPUTATION_SCORE}. Your current score is ${reputation.score}.`,
      });
    }

    if (dto.amount > reputation.maxCredit) {
      throw new BadRequestException({
        code: 'LOAN_AMOUNT_EXCEEDS_CREDIT',
        message: `Requested amount $${dto.amount} exceeds your maximum credit limit of $${reputation.maxCredit}. Improve your reputation score to unlock higher limits.`,
      });
    }

    const guarantee = Math.round(dto.amount * GUARANTEE_PERCENT * 100) / 100;
    const loanAmount = Math.round(dto.amount * LOAN_PERCENT * 100) / 100;
    const interestRate = reputation.interestRate;
    const interest = loanAmount * (interestRate / 100) * (dto.term / 12);
    const totalRepayment = Math.round((loanAmount + interest) * 100) / 100;
    const schedule = this.generateSchedule(totalRepayment, dto.term);

    return {
      merchant,
      terms: {
        amount: dto.amount,
        guarantee,
        loanAmount,
        interestRate,
        totalRepayment,
        term: dto.term,
        schedule,
      },
    };
  }

  private async validateMerchant(merchantId: string): Promise<ValidMerchant> {
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

    return merchant;
  }

  private generateProvisionalLoanId(): string {
    return `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async persistPendingLoan(record: CreateLoanRecord): Promise<void> {
    const client = this.supabaseService.getServiceRoleClient();
    const { error } = await client.from('loans').insert(record);

    if (error) {
      throw new Error(error.message ?? 'Supabase insert failed');
    }
  }

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
