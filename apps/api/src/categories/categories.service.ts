import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/create-category.dto';
import { ListQueryDto, MAX_LIST_TAKE, pageArgs } from '../common/pagination';

interface CategoryNode {
  id: string;
  parentId: string | null;
  path: string;
  depth: number;
}

/** The columns an update may write (never a spread of the request body). */
function pickCategoryFields(dto: UpdateCategoryDto): Prisma.CategoryUncheckedUpdateInput {
  const data: Prisma.CategoryUncheckedUpdateInput = {};
  if (dto.name !== undefined) data.name = dto.name;
  if (dto.slug !== undefined) data.slug = dto.slug;
  if (dto.imageUrl !== undefined) data.imageUrl = dto.imageUrl;
  if (dto.isActive !== undefined) data.isActive = dto.isActive;
  return data;
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(dto: CreateCategoryDto) {
    const shopId = this.tenantContext.getShopId();

    let path = '/';
    let depth = 0;

    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({
        where: { id: dto.parentId, shopId, isDeleted: false }
      });
      if (!parent) throw new BadRequestException('Parent category not found');
      
      // Calculate Materialized Path
      path = `${parent.path}${parent.id}/`;
      depth = parent.depth + 1;
    }

    return this.prisma.category.create({
      data: {
        ...dto,
        shopId,
        path,
        depth
      }
    });
  }

  /** Tree order (depth, sortOrder); the default page is the hard cap so a normal shop's tree arrives whole. */
  async findAll(query?: ListQueryDto) {
    const shopId = this.tenantContext.getShopId();
    const { skip, take } = pageArgs(query, MAX_LIST_TAKE);
    const where = { shopId, isDeleted: false };
    const [items, total] = await Promise.all([
      this.prisma.category.findMany({ where, orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }], skip, take }),
      this.prisma.category.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  async findOne(id: string) {
    const shopId = this.tenantContext.getShopId();
    const category = await this.prisma.category.findFirst({
      where: { id, shopId, isDeleted: false },
      include: { subCategories: { where: { isDeleted: false }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: MAX_LIST_TAKE } }
    });
    if (!category) throw new NotFoundException('Category not found');
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const shopId = this.tenantContext.getShopId();
    const fields = pickCategoryFields(dto);
    // `parentId` absent: no move. `parentId: null`: move to the root. A string: move under that parent.
    const targetParentId: string | null | undefined = Object.prototype.hasOwnProperty.call(dto, 'parentId') ? (dto.parentId ?? null) : undefined;

    if (targetParentId === undefined) {
      await this.findOne(id); // existence check: throws NotFoundException
      return this.prisma.category.update({ where: { id }, data: fields });
    }
    if (targetParentId === id) throw new BadRequestException('Cannot set category as its own parent');

    // The category and its whole subtree move in one transaction (roadmap 5.7). The
    // category and the new parent rows are locked for its length, so two concurrent
    // moves can neither build a cycle nor re-root the subtree from a stale prefix.
    return this.prisma.$transaction(async (tx) => {
      const [category] = await tx.$queryRaw<CategoryNode[]>`
        SELECT \`id\`, \`parentId\`, \`path\`, \`depth\` FROM \`Category\`
        WHERE \`id\` = ${id} AND \`shopId\` = ${shopId} AND \`isDeleted\` = 0 FOR UPDATE`;
      if (!category) throw new NotFoundException('Category not found');
      if (targetParentId === category.parentId) {
        return tx.category.update({ where: { id }, data: fields });
      }

      let path = '/';
      let depth = 0;
      if (targetParentId !== null) {
        const [parent] = await tx.$queryRaw<CategoryNode[]>`
          SELECT \`id\`, \`parentId\`, \`path\`, \`depth\` FROM \`Category\`
          WHERE \`id\` = ${targetParentId} AND \`shopId\` = ${shopId} AND \`isDeleted\` = 0 FOR UPDATE`;
        if (!parent) throw new BadRequestException('Parent category not found');
        if (parent.path.includes(`/${id}/`)) throw new BadRequestException('Cannot move a category under its own child');
        path = `${parent.path}${parent.id}/`;
        depth = parent.depth + 1;
      }

      const updated = await tx.category.update({ where: { id }, data: { ...fields, parentId: targetParentId, path, depth } });
      await this.updateDescendantsPath(tx, id, shopId, category.path, updated.path, category.depth, updated.depth);
      return updated;
    });
  }

  /**
   * Re-roots every descendant of a moved category with one UPDATE (roadmap
   * 5.7): the old prefix `<oldParentPath><id>/` is swapped for the new one and
   * the depth shifted by the same delta for the whole subtree, instead of one
   * `update` per descendant. `path LIKE '<prefix>%'` walks the `(shopId, path)`
   * index; the prefix is LIKE-escaped although ids never carry wildcards.
   * Returns the number of descendants moved.
   */
  private async updateDescendantsPath(
    tx: Prisma.TransactionClient,
    categoryId: string,
    shopId: string,
    oldParentPath: string,
    newParentPath: string,
    oldDepth: number,
    newDepth: number,
  ): Promise<number> {
    const oldPrefix = `${oldParentPath}${categoryId}/`;
    const newPrefix = `${newParentPath}${categoryId}/`;
    const depthDelta = newDepth - oldDepth;
    if (oldPrefix === newPrefix && depthDelta === 0) return 0;
    const pattern = `${oldPrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const now = new Date(); // application clock, UTC (roadmap 8.2)
    return tx.$executeRaw`
      UPDATE \`Category\`
      SET \`path\` = CONCAT(${newPrefix}, SUBSTRING(\`path\`, CHAR_LENGTH(${oldPrefix}) + 1)),
          \`depth\` = \`depth\` + ${depthDelta},
          \`updatedAt\` = ${now}
      WHERE \`shopId\` = ${shopId}
        AND \`isDeleted\` = 0
        AND \`path\` LIKE ${pattern}
    `;
  }

  async softDelete(id: string) {
    const shopId = this.tenantContext.getShopId();
    await this.findOne(id); // existence check: throws NotFoundException
    
    // Check if it has active children
    const childrenCount = await this.prisma.category.count({
        where: { parentId: id, shopId, isDeleted: false }
    });

    if (childrenCount > 0) {
        throw new BadRequestException('Cannot delete category with active subcategories');
    }

    return this.prisma.category.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date() }
    });
  }
}
