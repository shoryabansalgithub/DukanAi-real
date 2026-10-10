import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { IsAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password-policy';
import { ApiProperty } from '@nestjs/swagger';

/** `POST /auth/forgot-password`: always answers the same message, whatever the address (no account enumeration). */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  @MaxLength(191)
  email: string;
}

/** `POST /auth/reset-password`: the token from the email link plus the new password (same rule as registration). */
export class ResetPasswordDto {
  @ApiProperty({ description: '64 hex characters from the reset link' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/i, { message: 'token must be the 64-character code from the reset link' })
  token: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @IsAcceptablePassword()
  password: string;
}
