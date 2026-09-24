import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { InvoiceStatus, InvoiceType, Prisma, UdharTransactionType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';

/** Job data for `refresh-analytics`. Customer and UdharTransaction are tenant-scoped, so shopId is mandatory. */
export interface RefreshCustomerAnalyticsJobData {
  customerId: string;
  shopId: string;
  correlationId?: string;
}

export interface ValidateAddressJobData {
  addressId: string;
}

const ZERO = new Prisma.Decimal(0);

@Injectable()
@Processor('customer-queue')
export class CustomerWorker extends WorkerHost {
  private readonly logger = new Logger(CustomerWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    if (job.name === 'refresh-analytics') {
      return this.handleRefreshAnalytics(job);
    }
    if (job.name === 'validate-address') {
      return this.handleAddressValidation(job);
    }
    this.logger.warn(`Unknown job name: ${job.name}`);
  }

  /**
   * Recomputes the customer's denormalised balances from the udhar ledger, never
   * from invoices:
   *   outstandingBalance = SUM(CREDIT) - SUM(PAYMENT) - SUM(ADJUSTMENT) - SUM(WRITEOFF)
   *   totalPaid          = SUM(PAYMENT)
   *   totalPurchases     = SUM(COMPLETED SALE totals) - SUM(COMPLETED SALES_RETURN totals)
   */
  private async handleRefreshAnalytics(job: Job<Partial<RefreshCustomerAnalyticsJobData>, any, string>) {
    const { customerId, shopId } = job.data ?? {};
    if (!customerId || !shopId) {
      const message = `refresh-analytics job ${String(job.id)} is missing ${!customerId ? 'customerId' : 'shopId'}; the enqueuer must provide both (tenant-scoped models).`;
      this.logger.error(message);
      throw new UnrecoverableError(message);
    }

    this.logger.log(`Refreshing analytics for customer ${customerId} in shop ${shopId}`);

    return this.tenantContext.runWithContext(
      {
        shopId,
        correlationId: job.data.correlationId ?? `customer-analytics-${String(job.id ?? randomUUID())}`,
        requestId: randomUUID(),
      },
      async () =>
        // The recompute overwrites Customer.outstandingBalance, so it takes the
        // same row lock the billing and repayment transactions take and reads
        // the ledger inside that lock; a concurrent sale can never be clobbered.
        this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM Customer WHERE id = ${customerId} AND shopId = ${shopId} FOR UPDATE`;
        const [ledger, sales, returns] = await Promise.all([
          tx.udharTransaction.groupBy({
            by: ['type'],
            where: { customerId, shopId },
            _sum: { amount: true },
          }),
          tx.invoice.aggregate({
            where: { customerId, shopId, isDeleted: false, status: InvoiceStatus.COMPLETED, type: InvoiceType.SALE },
            _sum: { totalAmount: true },
          }),
          tx.invoice.aggregate({
            where: { customerId, shopId, isDeleted: false, status: InvoiceStatus.COMPLETED, type: InvoiceType.SALES_RETURN },
            _sum: { totalAmount: true },
          }),
        ]);

        const sumOf = (type: UdharTransactionType): Prisma.Decimal =>
          ledger.find((row) => row.type === type)?._sum.amount ?? ZERO;

        const credit = sumOf(UdharTransactionType.CREDIT);
        const payment = sumOf(UdharTransactionType.PAYMENT);
        const adjustment = sumOf(UdharTransactionType.ADJUSTMENT);
        const writeoff = sumOf(UdharTransactionType.WRITEOFF);

        const outstandingBalance = credit.minus(payment).minus(adjustment).minus(writeoff);
        const totalPaid = payment;
        const totalPurchases = (sales._sum.totalAmount ?? ZERO).minus(returns._sum.totalAmount ?? ZERO);

        const result = await tx.customer.updateMany({
          where: { id: customerId, shopId },
          data: { outstandingBalance, totalPurchases, totalPaid },
        });
        if (result.count === 0) {
          throw new UnrecoverableError(`Customer ${customerId} not found in shop ${shopId}`);
        }

        this.logger.log(
          `Customer ${customerId} analytics refreshed: outstanding=${outstandingBalance.toFixed(2)} purchases=${totalPurchases.toFixed(2)} paid=${totalPaid.toFixed(2)}`,
        );

        return {
          status: 'Analytics Refreshed',
          outstandingBalance: outstandingBalance.toFixed(2),
          totalPurchases: totalPurchases.toFixed(2),
          totalPaid: totalPaid.toFixed(2),
        };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }),
    );
  }

  private async handleAddressValidation(job: Job<ValidateAddressJobData, any, string>) {
    this.logger.log(`Validating address ${job.data.addressId}`);
    await this.prisma.customerAddress.update({
      where: { id: job.data.addressId },
      data: { geoVerified: true }
    });
    return { status: 'Address Validated' };
  }
}
