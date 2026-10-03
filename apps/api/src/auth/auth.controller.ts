import { Body, Controller, Get, HttpCode, Post, Request, UseGuards, Delete, Param, Ip, Headers, Query } from '@nestjs/common';
import { ListQueryDto, PagedList } from '../common/pagination';
import { LocalAuthGuard } from './local-auth.guard';
import { AuthService, LoginResponseDto } from './auth.service';
import { Public } from './public.decorator';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { SafeUserDto } from '../users/dto/safe-user.dto';
import type { Request as ExpressRequest } from 'express';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { GoogleIdentityService } from './google-identity.service';
import { AnyAuthenticated } from './/any-authenticated.decorator';
import { AuthThrottle } from '../common/throttling/auth-throttle.decorator';
import { PasswordResetService } from './password-reset.service';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-reset.dto';

interface AuthenticatedRequest extends ExpressRequest {
  /** `sessionId` is set by JwtStrategy from the token's `sid` claim. */
  user: SafeUserDto & { sessionId: string };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly googleIdentityService: GoogleIdentityService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Public()
  @AuthThrottle()
  @Post('register')
  @ApiOperation({ summary: 'Register a new shop and its OWNER account (staff join a shop through invitations)' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, type: SafeUserDto })
  async register(@Body() body: CreateUserDto): Promise<SafeUserDto> {
    // Registration creates a shop and its OWNER (UsersService.create); every other role arrives through an invitation.
    // DTO mass assignment protection strips unknown fields.
    const safeBody: CreateUserDto = {
      email: body.email,
      password: body.password,
      name: body.name,
      shopName: body.shopName,
    };

    return this.usersService.create(safeBody);
  }

  @Public()
  @AuthThrottle()
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  async login(@Request() req: AuthenticatedRequest, @Ip() ip: string, @Headers('user-agent') userAgent: string): Promise<LoginResponseDto> {
    return this.authService.login(req.user, ip, userAgent);
  }

  @Public()
  @AuthThrottle()
  @Post('google')
  @ApiOperation({ summary: 'Authenticate or register via Google OAuth' })
  @ApiBody({ type: GoogleAuthDto })
  @ApiResponse({ status: 200, type: SafeUserDto })
  async googleAuth(
    @Body() body: GoogleAuthDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<LoginResponseDto> {
    const identity = await this.googleIdentityService.verifyIdToken(body.idToken);
    const user = await this.usersService.findOrCreateGoogleUser(identity.googleId, identity.email, identity.name);
    return this.authService.login(user, ip, userAgent);
  }

  @Public()
  @AuthThrottle()
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiResponse({ status: 201, type: SafeUserDto })
  async refresh(
    @Body() body: RefreshTokenDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string,
  ): Promise<LoginResponseDto> {
    return this.authService.refresh(body.refresh_token, ip, userAgent);
  }

  @Public()
  @AuthThrottle()
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Email a password reset link; the answer never reveals whether the address has an account' })
  forgotPassword(@Body() body: ForgotPasswordDto): Promise<{ message: string }> {
    return this.passwordReset.request(body.email);
  }

  @Public()
  @AuthThrottle()
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password with the emailed token; ends every session of the account' })
  resetPassword(@Body() body: ResetPasswordDto): Promise<{ message: string }> {
    return this.passwordReset.reset(body.token, body.password);
  }

  @AnyAuthenticated()
  @Post('logout')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'End the current session: its refresh token and access tokens stop working at once' })
  logout(@Request() req: AuthenticatedRequest): Promise<{ message: string }> {
    return this.authService.logout(req.user.id, req.user.sessionId);
  }

  @Get('sessions')
  @PagedList()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all active sessions for the current user' })
  getSessions(@Request() req: AuthenticatedRequest, @Query() query: ListQueryDto) {
    return this.authService.getSessions(req.user.id, query);
  }

  @AnyAuthenticated()
  @Delete('sessions/:id')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke a specific session' })
  revokeSession(@Request() req: AuthenticatedRequest, @Param('id') sessionId: string) {
    return this.authService.revokeSession(sessionId, req.user.id);
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, type: SafeUserDto })
  getProfile(@Request() req: AuthenticatedRequest): SafeUserDto {
    return req.user;
  }
}
