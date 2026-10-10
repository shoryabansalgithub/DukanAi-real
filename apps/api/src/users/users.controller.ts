import { Controller, Get, Request, Param, Patch, Delete, Body, ForbiddenException, BadRequestException, Query } from '@nestjs/common';
import { ListQueryDto, PagedList, pageArgs } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { SocketSessionService } from '../iam/websockets/socket-session.service';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';
import { safeUserSelect } from './user.mapper';
import { outranks } from '../auth/role-sets';

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly socketSessionService: SocketSessionService,
  ) {}

  @Get('employees')
  @PagedList()
  @Roles(Role.OWNER, Role.ADMIN, Role.SUPER_ADMIN, Role.MANAGER)
  async getEmployees(@Request() req: any, @Query() query: ListQueryDto) {
    const { skip, take } = pageArgs(query);
    const where = { shopId: req.user.shopId, isDeleted: false };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          isActive: true,
          isLocked: true,
          createdAt: true,
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, skip, take };
  }

  @Patch(':id/suspend')
  @Roles(Role.OWNER, Role.ADMIN)
  async suspendUser(@Param('id') id: string, @Request() req: any, @Body('isActive') isActive: boolean) {
    if (id === req.user.id) {
      throw new ForbiddenException('You cannot suspend yourself. Transfer ownership first if you are the owner.');
    }
    
    const userToSuspend = await this.prisma.user.findUnique({ where: { id, shopId: req.user.shopId } });
    if (!userToSuspend) throw new BadRequestException('User not found');
    
    if (!outranks(req.user.role as Role, userToSuspend.role)) {
      throw new ForbiddenException('You cannot suspend a user with an equal or higher role.');
    }

    // safeUserSelect: the response must never carry the password hash (P1-7).
    const result = await this.prisma.user.update({
      where: { id },
      data: { isActive, tokenVersion: { increment: 1 } },
      select: safeUserSelect,
    });

    await this.prisma.auditLog.create({
      data: {
        shopId: req.user.shopId,
        userId: req.user.id,
        action: isActive ? 'UNSUSPEND_USER' : 'SUSPEND_USER',
        entity: 'User',
        entityId: id,
        afterData: { isActive },
      }
    });

    if (!isActive) {
      this.socketSessionService.disconnectUser(id, 'Account suspended by administrator');
    }

    return result;
  }

  @Delete(':id')
  @Roles(Role.OWNER, Role.ADMIN)
  async deleteUser(@Param('id') id: string, @Request() req: any) {
    if (id === req.user.id) {
      throw new ForbiddenException('You cannot delete yourself. Transfer ownership first if you are the owner.');
    }

    const userToDelete = await this.prisma.user.findUnique({ where: { id, shopId: req.user.shopId } });
    if (!userToDelete) throw new BadRequestException('User not found');
    
    if (!outranks(req.user.role as Role, userToDelete.role)) {
      throw new ForbiddenException('You cannot delete a user with an equal or higher role.');
    }

    const result = await this.prisma.user.update({
      where: { id },
      data: { isDeleted: true, deletedAt: new Date(), isActive: false, tokenVersion: { increment: 1 } },
      select: safeUserSelect,
    });

    await this.prisma.auditLog.create({
      data: {
        shopId: req.user.shopId,
        userId: req.user.id,
        action: 'DELETE_USER',
        entity: 'User',
        entityId: id,
      }
    });

    this.socketSessionService.disconnectUser(id, 'Account deleted');

    return result;
  }
}
