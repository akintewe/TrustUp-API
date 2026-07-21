import { Test, TestingModule } from '@nestjs/testing';
import { LoanPaymentReminderProcessor } from '../../../../src/jobs/loan-payment-reminder/loan-payment-reminder.processor';
import { SupabaseService } from '../../../../src/database/supabase.client';
import { getReminderWindow } from '../../../../src/jobs/loan-payment-reminder/reminder-window.util';
import { createMockJob, createSupabaseChainMock } from '../../../helpers/job.helpers';
import { createActiveLoanFixture, dueDateOffsetDays } from '../../../fixtures/jobs.fixtures';

const NOW_ISO = '2026-07-20T09:00:00.000Z';

describe('LoanPaymentReminderProcessor', () => {
  let processor: LoanPaymentReminderProcessor;

  let loansChain: ReturnType<typeof createSupabaseChainMock>;
  let notificationsChain: ReturnType<typeof createSupabaseChainMock>;
  let merchantsChain: ReturnType<typeof createSupabaseChainMock>;

  const mockSupabaseClient = { from: jest.fn() };
  const mockSupabaseService = {
    getServiceRoleClient: jest.fn().mockReturnValue(mockSupabaseClient),
  };

  function resetChains() {
    loansChain = createSupabaseChainMock();
    notificationsChain = createSupabaseChainMock();
    merchantsChain = createSupabaseChainMock();

    mockSupabaseClient.from.mockImplementation((table: string) => {
      switch (table) {
        case 'loans':
          return loansChain;
        case 'notifications':
          return notificationsChain;
        case 'merchants':
          return merchantsChain;
        default:
          return createSupabaseChainMock();
      }
    });
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanPaymentReminderProcessor,
        { provide: SupabaseService, useValue: mockSupabaseService },
      ],
    }).compile();

    processor = module.get(LoanPaymentReminderProcessor);

    jest.clearAllMocks();
    mockSupabaseService.getServiceRoleClient.mockReturnValue(mockSupabaseClient);
    resetChains();

    jest.useFakeTimers().setSystemTime(new Date(NOW_ISO));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should be defined', () => {
    expect(processor).toBeDefined();
  });

  // =========================================================================
  // Reminder window classification (end-to-end through process())
  // =========================================================================

  describe('3-day reminder window', () => {
    it('should create a payment_reminder_3d notification for a loan due in 3 days', async () => {
      const loan = createActiveLoanFixture({
        next_payment_due: dueDateOffsetDays(NOW_ISO, 3),
      });

      loansChain.not.mockResolvedValue({ data: [loan], error: null });

      await processor.process(createMockJob());

      expect(notificationsChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_wallet: loan.user_wallet,
          type: 'payment_reminder_3d',
          title: 'Payment Due in 3 Days',
        }),
      );
    });
  });

  describe('1-day reminder window', () => {
    it('should create a payment_reminder_1d notification for a loan due in 1 day', async () => {
      const loan = createActiveLoanFixture({
        next_payment_due: dueDateOffsetDays(NOW_ISO, 1),
      });

      loansChain.not.mockResolvedValue({ data: [loan], error: null });

      await processor.process(createMockJob());

      expect(notificationsChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_wallet: loan.user_wallet,
          type: 'payment_reminder_1d',
          title: 'Payment Due Tomorrow',
        }),
      );
    });
  });

  describe('overdue window', () => {
    it('should create a payment_overdue notification for a loan past its due date', async () => {
      const loan = createActiveLoanFixture({
        next_payment_due: dueDateOffsetDays(NOW_ISO, -2),
      });

      loansChain.not.mockResolvedValue({ data: [loan], error: null });

      await processor.process(createMockJob());

      expect(notificationsChain.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_wallet: loan.user_wallet,
          type: 'payment_overdue',
          title: 'Loan Payment Overdue',
        }),
      );
    });
  });

  describe('outside any reminder window', () => {
    it('should not create a notification for a loan due in 5 days', async () => {
      const loan = createActiveLoanFixture({
        next_payment_due: dueDateOffsetDays(NOW_ISO, 5),
      });

      loansChain.not.mockResolvedValue({ data: [loan], error: null });

      await processor.process(createMockJob());

      expect(notificationsChain.insert).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Duplicate reminder skip
  // =========================================================================

  describe('duplicate reminder', () => {
    it('should skip creating a notification when one was already sent for this loan/window today', async () => {
      const loan = createActiveLoanFixture({
        next_payment_due: dueDateOffsetDays(NOW_ISO, 3),
      });

      loansChain.not.mockResolvedValue({ data: [loan], error: null });
      notificationsChain.gte.mockResolvedValue({ count: 1, error: null });

      await processor.process(createMockJob());

      expect(notificationsChain.insert).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Completed / inactive loans excluded at the query level
  // =========================================================================

  describe('completed loans', () => {
    it('should query only active loans, excluding completed ones from consideration', async () => {
      loansChain.not.mockResolvedValue({ data: [], error: null });

      await processor.process(createMockJob());

      expect(loansChain.eq).toHaveBeenCalledWith('status', 'active');
      expect(notificationsChain.insert).not.toHaveBeenCalled();
    });
  });

  describe('no active loans', () => {
    it('should skip the run entirely when no active loans are returned', async () => {
      loansChain.not.mockResolvedValue({ data: [], error: null });

      await expect(processor.process(createMockJob())).resolves.not.toThrow();

      expect(mockSupabaseClient.from).not.toHaveBeenCalledWith('notifications');
    });
  });
});

// ===========================================================================
// getReminderWindow (pure utility) unit tests
// ===========================================================================

describe('getReminderWindow', () => {
  const now = new Date('2026-07-20T09:00:00.000Z');

  it('should return "three-day" when due in exactly 3 days', () => {
    expect(getReminderWindow(new Date('2026-07-23T00:00:00.000Z'), now)).toBe('three-day');
  });

  it('should return "one-day" when due in exactly 1 day', () => {
    expect(getReminderWindow(new Date('2026-07-21T00:00:00.000Z'), now)).toBe('one-day');
  });

  it('should return "overdue" when the due date is in the past', () => {
    expect(getReminderWindow(new Date('2026-07-18T00:00:00.000Z'), now)).toBe('overdue');
  });

  it('should return null when due today', () => {
    expect(getReminderWindow(new Date('2026-07-20T00:00:00.000Z'), now)).toBeNull();
  });

  it('should return null when due in 2 days', () => {
    expect(getReminderWindow(new Date('2026-07-22T00:00:00.000Z'), now)).toBeNull();
  });

  it('should return null when due in 4 or more days', () => {
    expect(getReminderWindow(new Date('2026-07-24T00:00:00.000Z'), now)).toBeNull();
  });
});
