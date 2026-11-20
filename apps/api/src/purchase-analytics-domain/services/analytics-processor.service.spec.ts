import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsProcessorService } from './analytics-processor.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { Job } from 'bullmq';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { Clock } from '../../common/time/clock';

describe('AnalyticsProcessorService', () => {
  let service: AnalyticsProcessorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsProcessorService,
        TenantContextService,
        { provide: Clock, useValue: { now: () => new Date('2026-10-11T20:00:00Z') } },
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([{ avg_days: 5 }]),
            shopSettings: { findUnique: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
            purchaseOrder: {
              count: jest.fn().mockResolvedValue(10),
              aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: 1000 } }),
              groupBy: jest.fn().mockResolvedValue([{ department: 'IT', _sum: { totalAmount: 1000 } }])
            },
            goodsReceipt: {
              count: jest.fn().mockResolvedValue(5)
            },
            vendorBill: {
              count: jest.fn().mockResolvedValue(5),
              aggregate: jest.fn().mockResolvedValue({ _sum: { outstandingAmount: 500 } })
            }
          }
        },
        {
          provide: AnalyticsRepository,
          useValue: {
            upsertDashboardSnapshot: jest.fn(),
            upsertVendorPerformanceSnapshot: jest.fn(),
            upsertCategorySpendSnapshot: jest.fn(),
            upsertTrendSnapshot: jest.fn()
          }
        }
      ],
    }).compile();

    service = module.get<AnalyticsProcessorService>(AnalyticsProcessorService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should process dashboard job with SQL lead time', async () => {
    const job = { name: 'aggregate-daily-dashboard', data: { shopId: 'shop-1' } } as Job;
    await service.process(job);
    // Ensure it ran without crashing
    expect(service).toBeDefined();
  });

  it('keys the daily snapshot and the month by the shop\'s business day, not the server\'s (release audit #26)', async () => {
    const repository = (service as unknown as { repository: { upsertDashboardSnapshot: jest.Mock; upsertTrendSnapshot: jest.Mock } }).repository;
    // 20:00 UTC on 11 October is already 12 October 01:30 in Asia/Kolkata.
    await service.process({ name: 'aggregate-daily-dashboard', data: { shopId: 'shop-1' } } as Job);
    expect(repository.upsertDashboardSnapshot.mock.calls[0][1].toISOString()).toBe('2026-10-12T00:00:00.000Z');

    await service.process({ name: 'aggregate-trends', data: { shopId: 'shop-1' } } as Job);
    const [, , periodStart] = repository.upsertTrendSnapshot.mock.calls[0];
    expect(periodStart.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    // The month's orders are counted from 1 October 00:00 IST = 30 September 18:30 UTC.
    const prisma = (service as unknown as { prisma: { purchaseOrder: { aggregate: jest.Mock } } }).prisma;
    const where = prisma.purchaseOrder.aggregate.mock.calls.at(-1)[0].where;
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
});
