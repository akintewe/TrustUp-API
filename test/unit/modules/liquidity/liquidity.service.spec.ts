import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadRequestException, HttpException } from '@nestjs/common';
import { LiquidityService } from '../../../../src/modules/liquidity/liquidity.service';
import { LiquidityContractClient } from '../../../../src/blockchain/contracts/liquidity-contract.client';
import { SupabaseService } from '../../../../src/database/supabase.client';

describe('LiquidityService', () => {
  let service: LiquidityService;

  const validWallet = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
  const STROOPS = 10_000_000n;

  const mockCacheManager = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const mockSupabaseService = {
    getServiceRoleClient: jest.fn(),
  };

  const mockLiquidityContractClient = {
    getLpShares: jest.fn(),
    getPoolStats: jest.fn(),
    calculateWithdrawal: jest.fn(),
    buildWithdrawTx: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LiquidityService,
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: LiquidityContractClient, useValue: mockLiquidityContractClient },
      ],
    }).compile();

    service = module.get<LiquidityService>(LiquidityService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('withdrawLiquidity', () => {
    it('should construct an unsigned XDR and preview for a valid partial withdrawal', async () => {
      mockLiquidityContractClient.getLpShares.mockResolvedValue(925n * STROOPS);
      mockLiquidityContractClient.getPoolStats.mockResolvedValue({
        totalLiquidity: 100000n * STROOPS,
        lockedLiquidity: 98500n * STROOPS,
        availableLiquidity: 1500n * STROOPS,
        totalShares: 92500n * STROOPS,
        sharePrice: 10800n,
        withdrawalFeeBps: 50n,
      });
      mockLiquidityContractClient.calculateWithdrawal.mockResolvedValue(540n * STROOPS);
      mockLiquidityContractClient.buildWithdrawTx.mockResolvedValue('AAAAAgAAAAA...');

      const result = await service.withdrawLiquidity(validWallet, { shares: 500 });

      expect(result).toEqual({
        unsignedXdr: 'AAAAAgAAAAA...',
        description: 'Withdraw 500 shares from liquidity pool',
        preview: {
          shares: 500,
          ownedShares: 925,
          remainingShares: 425,
          currentSharePrice: 1.08,
          expectedAmount: 540,
          feeBps: 50,
          fee: 2.7,
          netAmount: 537.3,
          availableLiquidity: 1500,
        },
      });
      expect(mockLiquidityContractClient.buildWithdrawTx).toHaveBeenCalledWith(
        validWallet,
        500n * STROOPS,
      );
    });

    it('should reject zero or negative shares before hitting the blockchain client', async () => {
      await expect(service.withdrawLiquidity(validWallet, { shares: 0 })).rejects.toThrow(
        BadRequestException,
      );

      expect(mockLiquidityContractClient.getLpShares).not.toHaveBeenCalled();
      expect(mockLiquidityContractClient.getPoolStats).not.toHaveBeenCalled();
    });

    it('should reject withdrawals above the user share balance', async () => {
      mockLiquidityContractClient.getLpShares.mockResolvedValue(4999999999n);
      mockLiquidityContractClient.getPoolStats.mockResolvedValue({
        totalLiquidity: 100000n * STROOPS,
        lockedLiquidity: 90000n * STROOPS,
        availableLiquidity: 10000n * STROOPS,
        totalShares: 100000n * STROOPS,
        sharePrice: 10800n,
        withdrawalFeeBps: 0n,
      });

      await expect(service.withdrawLiquidity(validWallet, { shares: 500 })).rejects.toMatchObject({
        response: { code: 'LIQUIDITY_INSUFFICIENT_SHARES' },
      });
    });

    it('should fail gracefully when pool available liquidity is insufficient', async () => {
      mockLiquidityContractClient.getLpShares.mockResolvedValue(1000n * STROOPS);
      mockLiquidityContractClient.getPoolStats.mockResolvedValue({
        totalLiquidity: 100000n * STROOPS,
        lockedLiquidity: 99600n * STROOPS,
        availableLiquidity: 400n * STROOPS,
        totalShares: 100000n * STROOPS,
        sharePrice: 10800n,
        withdrawalFeeBps: 0n,
      });
      mockLiquidityContractClient.calculateWithdrawal.mockResolvedValue(540n * STROOPS);

      await expect(service.withdrawLiquidity(validWallet, { shares: 500 })).rejects.toThrow(
        HttpException,
      );

      try {
        await service.withdrawLiquidity(validWallet, { shares: 500 });
        fail('Expected insufficient liquidity error');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(402);
        expect((error as HttpException).getResponse()).toEqual(
          expect.objectContaining({
            code: 'LIQUIDITY_INSUFFICIENT_AVAILABLE_LIQUIDITY',
          }),
        );
      }
    });

    it('should support zero configured withdrawal fees', async () => {
      mockLiquidityContractClient.getLpShares.mockResolvedValue(1000n * STROOPS);
      mockLiquidityContractClient.getPoolStats.mockResolvedValue({
        totalLiquidity: 100000n * STROOPS,
        lockedLiquidity: 90000n * STROOPS,
        availableLiquidity: 10000n * STROOPS,
        totalShares: 100000n * STROOPS,
        sharePrice: 10000n,
        withdrawalFeeBps: 0n,
      });
      mockLiquidityContractClient.calculateWithdrawal.mockResolvedValue(2505000000n);
      mockLiquidityContractClient.buildWithdrawTx.mockResolvedValue('AAAAAgAAAAA...');

      const result = await service.withdrawLiquidity(validWallet, { shares: 250.5 });

      expect(result.preview.expectedAmount).toBe(250.5);
      expect(result.preview.fee).toBe(0);
      expect(result.preview.netAmount).toBe(250.5);
      expect(result.preview.remainingShares).toBe(749.5);
    });
  });
});
