import { Test, TestingModule } from '@nestjs/testing';
import { ReputationService, Reputation } from '../../../../src/modules/reputation/reputation.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../../../../src/database/supabase.client';

describe('ReputationService', () => {
    let service: ReputationService;
    let cacheManager: any;

    const mockCacheManager = {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
    };

    const mockSupabaseClient = {
        from: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn().mockReturnThis(),
    };

    const mockSupabaseService = {
        getClient: jest.fn(() => mockSupabaseClient),
    };

    const mockConfigService = {
        get: jest.fn((key: string, defaultValue: any) => defaultValue),
    };

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ReputationService,
                { provide: CACHE_MANAGER, useValue: mockCacheManager },
                { provide: ConfigService, useValue: mockConfigService },
                { provide: SupabaseService, useValue: mockSupabaseService },
            ],
        }).compile();

        service = module.get<ReputationService>(ReputationService);
        cacheManager = module.get(CACHE_MANAGER);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('getReputationScore', () => {
        const wallet = 'GABC123TEST';
        const cacheKey = `reputation:${wallet}`;

        it('should return cached object from Redis if available (Hot Cache HIT)', async () => {
            const mockReputation: Reputation = {
                wallet,
                score: 95,
                tier: 'gold',
                interestRate: 5,
                maxCredit: 5000,
                lastUpdated: new Date().toISOString(),
            };
            mockCacheManager.get.mockResolvedValue(mockReputation);

            const result = await service.getReputationScore(wallet);

            expect(result).toEqual(mockReputation);
            expect(mockCacheManager.get).toHaveBeenCalledWith(cacheKey);
        });

        it('should fall back to Supabase and return mapped object (Warm Cache HIT)', async () => {
            mockCacheManager.get.mockResolvedValue(null);
            mockSupabaseClient.single.mockResolvedValue({
                data: { score: 75, last_synced_at: new Date().toISOString() },
                error: null,
            });

            const result = await service.getReputationScore(wallet);

            expect(result.score).toBe(75);
            expect(result.tier).toBe('silver');
            expect(mockCacheManager.set).toHaveBeenCalled();
        });

        it('should fetch and map blockchain data correctly', async () => {
            mockCacheManager.get.mockResolvedValue(null);
            mockSupabaseClient.single.mockResolvedValue({ data: null, error: 'Not found' });

            const result = await service.getReputationScore(wallet);

            expect(result).toHaveProperty('score');
            expect(result).toHaveProperty('tier');
            expect(['gold', 'silver', 'bronze', 'poor']).toContain(result.tier);
        });
        it('should fetch from blockchain and use correct column name (wallet_address) for Supabase persistence', async () => {
            mockCacheManager.get.mockResolvedValue(null);
            mockSupabaseClient.single.mockResolvedValue({ data: null, error: 'Not found' }); // For initial check

            // Mock user lookup inside persistReputation
            mockSupabaseClient.single.mockResolvedValueOnce({ data: null, error: 'Not found' })
                .mockResolvedValueOnce({ data: { id: 'user-id' }, error: null });

            await service.getReputationScore(wallet);

            // Verify that we are using 'wallet_address' and not 'wallet'
            expect(mockSupabaseClient.from).toHaveBeenCalledWith('users');
            expect(mockSupabaseClient.eq).toHaveBeenCalledWith('wallet_address', wallet);
        });
    });
});
