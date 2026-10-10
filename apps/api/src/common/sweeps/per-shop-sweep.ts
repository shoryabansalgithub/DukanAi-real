import { Logger } from '@nestjs/common';
import { ShopStatus } from '@prisma/client';
import { jobContext } from '../../iam/tenant-context/job-context';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface SweepSummary {
  shops: number;
  affected: number;
  failed: number;
}

/** Shops a global sweep visits: everything that can still trade or be reopened (also `reconcile --all-shops`). */
export const SWEPT_SHOP_STATUSES: ShopStatus[] = [ShopStatus.ACTIVE, ShopStatus.SUSPENDED, ShopStatus.LOCKED];

/** Shops are visited in pages so a sweep never loads every tenant into memory at once. */
export const SWEEP_PAGE_SIZE = 200;

/**
 * Runs a per-shop sweep across every shop (roadmap 1.7). The shop list is
 * read as the system tenant, one page at a time; each shop's sweep then runs
 * inside that shop's tenant context, so the sweep body can only touch that
 * shop's rows, and a failure in one shop is logged and never stops the others.
 */
export async function sweepEveryShop(
  prisma: PrismaService,
  tenantContext: TenantContextService,
  logger: Logger,
  jobName: string,
  sweepShop: (shopId: string) => Promise<number>,
): Promise<SweepSummary> {
  const summary: SweepSummary = { shops: 0, affected: 0, failed: 0 };
  let cursor: string | undefined;
  for (;;) {
    // Awaited inside the scope: a bare PrismaPromise is lazy and would run outside the bypass.
    const page = await tenantContext.runAsSuperAdmin(async () =>
      await prisma.shop.findMany({
        where: { status: { in: SWEPT_SHOP_STATUSES } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: SWEEP_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
    for (const shop of page) {
      summary.shops += 1;
      try {
        summary.affected += await tenantContext.runWithContext(jobContext(shop.id, jobName), () => sweepShop(shop.id));
      } catch (error: unknown) {
        summary.failed += 1;
        logger.error(`${jobName} failed for shop ${shop.id}: ${(error as Error).message}`);
      }
    }
    if (page.length < SWEEP_PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }
  logger.log(`${jobName}: ${summary.affected} row(s) across ${summary.shops} shop(s), ${summary.failed} failed`);
  return summary;
}
