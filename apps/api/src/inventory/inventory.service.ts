import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { ListQueryDto, pageArgs } from '../common/pagination';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  /** Active products by name, hard-capped page (roadmap 5.6; the route used to answer a fixed 50). */
  async getProducts(query?: ListQueryDto) {
    const shopId = this.tenantContext.getShopId();
    const { skip, take } = pageArgs(query);
    const where = { shopId, isDeleted: false, isActive: true };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take, skip }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, skip, take };
  }
}
