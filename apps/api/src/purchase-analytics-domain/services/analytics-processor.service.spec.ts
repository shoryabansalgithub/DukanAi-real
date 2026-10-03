import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsProcessorService } from './analytics-processor.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsRepository } from '../repositories/analytics.repository';
import { Job } from 'bullmq';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

describe('AnalyticsProcessorService', () => {
  let service: AnalyticsProcessorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsProcessorService,
        TenantContextService,
        {
          provide: PrismaService,
          useValue: {
            $queryRaw: jest.fn().mockResolvedValue([{ avg_days: 5 }]),
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
});
