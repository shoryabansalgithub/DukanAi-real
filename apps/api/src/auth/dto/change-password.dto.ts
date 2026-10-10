import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { IsAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../password-policy';

/**
 * `POST /auth/change-password` (ASVS 2.1.5, roadmap 9.15): the signed-in user
 * proves the current password and sets a new one under the same policy as
 * registration. Every session of the account ends afterwards.
 */
export class ChangePasswordDto {
  @ApiProperty({ maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword: string;

  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @IsAcceptablePassword()
  newPassword: string;
}
