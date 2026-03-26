import { Test, TestingModule } from '@nestjs/testing';
import { LoansController } from '../../../../src/modules/loans/loans.controller';
import { LoansService } from '../../../../src/modules/loans/loans.service';

describe('LoansController', () => {
  let controller: LoansController;
  let loansService: LoansService;

  const validWallet = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';

  const mockQuoteResponse = {
    amount: 500,
    guarantee: 100,
    loanAmount: 400,
    interestRate: 8,
    totalRepayment: 410.67,
    term: 4,
    schedule: [
      { paymentNumber: 1, amount: 102.66, dueDate: '2026-03-13T00:00:00.000Z' },
      { paymentNumber: 2, amount: 102.66, dueDate: '2026-04-13T00:00:00.000Z' },
      { paymentNumber: 3, amount: 102.66, dueDate: '2026-05-13T00:00:00.000Z' },
      { paymentNumber: 4, amount: 102.69, dueDate: '2026-06-13T00:00:00.000Z' },
    ],
  };

  const mockLoansService = {
    calculateLoanQuote: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LoansController],
      providers: [
        { provide: LoansService, useValue: mockLoansService },
      ],
    }).compile();

    controller = module.get<LoansController>(LoansController);
    loansService = module.get<LoansService>(LoansService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // POST /loans/quote
  // ---------------------------------------------------------------------------
  describe('getLoanQuote', () => {
    const validDto = {
      amount: 500,
      merchant: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      term: 4,
    };

    it('should return a loan quote wrapped in response envelope', async () => {
      mockLoansService.calculateLoanQuote.mockResolvedValue(mockQuoteResponse);

      const user = { wallet: validWallet };
      const result = await controller.getLoanQuote(user, validDto);

      expect(result).toEqual({
        success: true,
        data: mockQuoteResponse,
        message: 'Loan quote calculated successfully',
      });
      expect(loansService.calculateLoanQuote).toHaveBeenCalledWith(
        validWallet,
        validDto,
      );
      expect(loansService.calculateLoanQuote).toHaveBeenCalledTimes(1);
    });

    it('should propagate service errors to the caller', async () => {
      mockLoansService.calculateLoanQuote.mockRejectedValue(
        new Error('Reputation fetch failed'),
      );

      const user = { wallet: validWallet };
      await expect(
        controller.getLoanQuote(user, validDto),
      ).rejects.toThrow('Reputation fetch failed');
    });
  });
});
