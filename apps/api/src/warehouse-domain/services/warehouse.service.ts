import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { rethrowUniqueViolation } from '../../common/db/unique-violation';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContextService } from '../../iam/tenant-context/tenant-context.service';
import { CreateWarehouseDto } from '../dto/warehouse.dto';
import { ListQueryDto, pageArgs } from '../../common/pagination';

@Injectable()
export class WarehouseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService
  ) {}

  async create(dto: CreateWarehouseDto) {
    const shopId = this.tenantContext.getShopId();
    
    // Friendly pre-check; the unique index (shopId, code, deletedToken) is the guard.
    const existing = await this.prisma.warehouse.findFirst({ where: { shopId, code: dto.code, isDeleted: false }, select: { id: true } });
    if (existing) throw new ConflictException({ message: `Warehouse code ${dto.code} already exists.`, code: 'WAREHOUSE_CODE_IN_USE', details: { warehouseId: existing.id } });

    try {
      return await this.prisma.warehouse.create({
        data: {
          ...dto,
          shopId
        }
      });
    } catch (error) {
      rethrowUniqueViolation(error, [{ index: 'Warehouse_shopId_code', code: 'WAREHOUSE_CODE_IN_USE', message: `Warehouse code ${dto.code} already exists.` }]);
    }
  }

  async findAll(query?: ListQueryDto) {
    const shopId = this.tenantContext.getShopId();
    const { skip, take } = pageArgs(query);
    const where = { shopId, isDeleted: false };
    const [items, total] = await Promise.all([
      this.prisma.warehouse.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.warehouse.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id, shopId, isDeleted: false }
    });
    if (!warehouse) throw new NotFoundException('Warehouse not found');
    return warehouse;
  }
}
