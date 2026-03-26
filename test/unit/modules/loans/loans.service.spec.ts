import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LoansService } from '../../../../src/modules/loans/loans.service';
import { ReputationService } from '../../../../src/modules/reputation/reputation.service';
import { SupabaseService } from '../../../../src/database/supabase.client';
import { CreditLineContractClient } from '../../../../src/blockchain/contracts/credit-line-contract.client';

describe('LoansService', () => {
  let service: LoansService;

  const validWallet = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
  const merchantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  const mockReputationService = {
    getReputationScore: jest.fn(),
  };

  const mockSupabaseFrom = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
  };

  const mockSupabaseClient = {
    from: jest.fn().mockReturnValue(mockSupabaseFrom),
  };

  const mockSupabaseService = {
    getServiceRoleClient: jest.fn().mockReturnValue(mockSupabaseClient),
  };

  const mockCreditLineClient = {
    buildRepayLoanTx: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: ReputationService, useValue: mockReputationService },
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: CreditLineContractClient, useValue: mockCreditLineClient },
      ],
    }).compile();

    service = module.get<LoansService>(LoansService);
    jest.clearAllMocks();

    // Reset the chained mock for each test
    mockSupabaseClient.from.mockReturnValue(mockSupabaseFrom);
    mockSupabaseFrom.select.mockReturnThis();
    mockSupabaseFrom.eq.mockReturnThis();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // calculateLoanQuote
  // ---------------------------------------------------------------------------
  describe('calculateLoanQuote', () => {
    const baseDto = { amount: 500, merchant: merchantId, term: 4 };

    function mockReputation(score: number, tier: string, interestRate: number, maxCredit: number) {
      mockReputationService.getReputationScore.mockResolvedValue({
        wallet: validWallet,
        score,
        tier,
        interestRate,
        maxCredit,
        lastUpdated: '2026-02-13T10:00:00.000Z',
      });
    }

    function mockMerchantFound(isActive = true) {
      mockSupabaseFrom.single.mockResolvedValue({
        data: { id: merchantId, name: 'TechStore', is_active: isActive },
        error: null,
      });
    }

    function mockMerchantNotFound() {
      mockSupabaseFrom.single.mockResolvedValue({
        data: null,
        error: { message: 'not found' },
      });
    }

    it('should calculate a quote for a gold tier user', async () => {
      mockReputation(95, 'gold', 5, 7500);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, baseDto);

      expect(result.amount).toBe(500);
      expect(result.guarantee).toBe(100);
      expect(result.loanAmount).toBe(400);
      expect(result.interestRate).toBe(5);
      expect(result.term).toBe(4);
      expect(result.totalRepayment).toBeGreaterThan(400);
      expect(result.schedule).toHaveLength(4);
    });

    it('should calculate a quote for a silver tier user', async () => {
      mockReputation(75, 'silver', 8, 2000);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, baseDto);

      expect(result.interestRate).toBe(8);
      expect(result.loanAmount).toBe(400);
      // Interest = 400 × 0.08 × (4/12) = 10.67
      // Total = 400 + 10.67 = 410.67
      expect(result.totalRepayment).toBeCloseTo(410.67, 1);
    });

    it('should calculate a quote for a bronze tier user', async () => {
      mockReputation(65, 'bronze', 9, 1500);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, baseDto);

      expect(result.interestRate).toBe(9);
      expect(result.guarantee).toBe(100);
      expect(result.loanAmount).toBe(400);
    });

    it('should calculate a quote for a poor tier user', async () => {
      mockReputation(40, 'poor', 12, 700);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, {
        ...baseDto,
        amount: 200,
      });

      expect(result.interestRate).toBe(12);
      expect(result.guarantee).toBe(40);
      expect(result.loanAmount).toBe(160);
    });

    it('should reject amount exceeding max credit', async () => {
      mockReputation(40, 'poor', 12, 300);
      mockMerchantFound();

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toMatchObject({
        response: { code: 'LOAN_AMOUNT_EXCEEDS_CREDIT' },
      });
    });

    it('should throw NotFoundException when merchant does not exist', async () => {
      mockReputation(75, 'silver', 8, 2000);
      mockMerchantNotFound();

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toMatchObject({
        response: { code: 'MERCHANT_NOT_FOUND' },
      });
    });

    it('should throw BadRequestException when merchant is inactive', async () => {
      mockReputation(75, 'silver', 8, 2000);
      mockMerchantFound(false);

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.calculateLoanQuote(validWallet, baseDto),
      ).rejects.toMatchObject({
        response: { code: 'MERCHANT_INACTIVE' },
      });
    });

    it('should set guarantee to 20% and loan to 80% of amount', async () => {
      mockReputation(90, 'gold', 5, 10000);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, {
        ...baseDto,
        amount: 1000,
      });

      expect(result.guarantee).toBe(200);
      expect(result.loanAmount).toBe(800);
    });

    it('should handle fractional amounts correctly', async () => {
      mockReputation(90, 'gold', 4, 10000);
      mockMerchantFound();

      const result = await service.calculateLoanQuote(validWallet, {
        ...baseDto,
        amount: 333,
        term: 3,
      });

      expect(result.guarantee).toBeCloseTo(66.6, 1);
      expect(result.loanAmount).toBeCloseTo(266.4, 1);
      expect(result.totalRepayment).toBeGreaterThan(result.loanAmount);
    });
  });

  // ---------------------------------------------------------------------------
  // generateSchedule
  // ---------------------------------------------------------------------------
  describe('generateSchedule', () => {
    it('should generate correct number of payments', () => {
      const schedule = service.generateSchedule(400, 4);
      expect(schedule).toHaveLength(4);
    });

    it('should have sequential payment numbers', () => {
      const schedule = service.generateSchedule(600, 3);
      expect(schedule.map((p) => p.paymentNumber)).toEqual([1, 2, 3]);
    });

    it('should sum to totalRepayment exactly', () => {
      const total = 410.67;
      const schedule = service.generateSchedule(total, 4);
      const sum = schedule.reduce((acc, p) => acc + p.amount, 0);
      expect(Math.round(sum * 100) / 100).toBe(total);
    });

    it('should have due dates 30 days apart (monthly)', () => {
      const schedule = service.generateSchedule(300, 3);

      for (let i = 0; i < schedule.length; i++) {
        const dueDate = new Date(schedule[i].dueDate);
        expect(dueDate.getHours()).toBe(0);
        expect(dueDate.getMinutes()).toBe(0);
        expect(dueDate.getSeconds()).toBe(0);
      }

      // Each due date should be roughly one month after the previous
      const d1 = new Date(schedule[0].dueDate);
      const d2 = new Date(schedule[1].dueDate);
      const diffDays = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(28);
      expect(diffDays).toBeLessThanOrEqual(31);
    });

    it('should handle single payment term', () => {
      const schedule = service.generateSchedule(500, 1);
      expect(schedule).toHaveLength(1);
      expect(schedule[0].amount).toBe(500);
      expect(schedule[0].paymentNumber).toBe(1);
    });

    it('should handle rounding remainder in last payment', () => {
      // 100 / 3 = 33.33 per payment, last payment absorbs remainder
      const schedule = service.generateSchedule(100, 3);
      const sum = schedule.reduce((acc, p) => acc + p.amount, 0);
      expect(Math.round(sum * 100) / 100).toBe(100);
    });

    it('should return valid ISO date strings', () => {
      const schedule = service.generateSchedule(200, 2);
      for (const payment of schedule) {
        expect(() => new Date(payment.dueDate)).not.toThrow();
        expect(new Date(payment.dueDate).toISOString()).toBe(payment.dueDate);
      }
    });
  });
});
