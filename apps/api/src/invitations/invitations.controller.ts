import { Controller, Post, Body, Delete, Param } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CurrentShop } from '../iam/decorators/current-shop.decorator';
import { CurrentUser } from '../iam/decorators/current-user.decorator';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import { MANAGEMENT_ROLES } from '../auth/role-sets';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';
import { AuthThrottle } from '../common/throttling/auth-throttle.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';

@ApiTags('invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post('generate')
  @ApiBearerAuth()
  @Roles(...MANAGEMENT_ROLES)
  @ApiOperation({ summary: 'Invite a new staff member (role below your own); the token is emailed to the invitee' })
  generate(
    @CurrentShop() shopId: string,
    @CurrentUser() actor: SafeUserDto,
    @Body() createInvitationDto: CreateInvitationDto,
  ) {
    return this.invitationsService.generate(shopId, { id: actor.id, role: actor.role }, createInvitationDto);
  }

  @Public()
  @AuthThrottle()
  @Post('accept')
  @ApiOperation({ summary: 'Accept an invitation and register an account' })
  @ApiResponse({ status: 201, description: 'User successfully created' })
  accept(@Body() acceptInvitationDto: AcceptInvitationDto) {
    return this.invitationsService.accept(acceptInvitationDto);
  }

  @Delete(':id/revoke')
  @ApiBearerAuth()
  @Roles(...MANAGEMENT_ROLES)
  @ApiOperation({ summary: 'Revoke a pending invitation (a MANAGER may revoke only their own)' })
  revoke(
    @CurrentShop() shopId: string,
    @CurrentUser() actor: SafeUserDto,
    @Param('id') id: string,
  ) {
    return this.invitationsService.revoke(shopId, { id: actor.id, role: actor.role }, id);
  }
}
