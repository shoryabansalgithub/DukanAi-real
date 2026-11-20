import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/notification.dto';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { AnyAuthenticated } from '../auth/any-authenticated.decorator';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @PagedList()
  findAll(@Query() query: ListQueryDto) {
    return this.notificationsService.findAll(query);
  }

  /** `{ count }` of unread notifications: the list is a capped page, so the navbar cannot count them itself. */
  @Get('unread-count')
  unreadCount() {
    return this.notificationsService.unreadCount();
  }

  @Roles(...MANAGEMENT_ROLES)
  @Post()
  create(@Body() dto: CreateNotificationDto) {
    return this.notificationsService.create(dto);
  }

  // Notifications are shop-wide: clearing all of them hides every alert from
  // everyone, so it is a management action (audit T6b). Marking one read stays open.
  @Roles(...MANAGEMENT_ROLES)
  @Patch('read-all')
  markAllRead() {
    return this.notificationsService.markAllRead();
  }

  @AnyAuthenticated()
  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.notificationsService.markRead(id);
  }
}
