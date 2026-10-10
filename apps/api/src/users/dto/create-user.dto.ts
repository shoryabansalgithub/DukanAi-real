import { IsAcceptablePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../auth/password-policy';
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'owner@example.com' })
  @IsEmail()
  email: string;

  /** The one password policy (src/auth/password-policy.ts): 12-72 characters, not a common password. */
  @ApiProperty({ minLength: MIN_PASSWORD_LENGTH, maxLength: MAX_PASSWORD_LENGTH })
  @IsString()
  @IsAcceptablePassword()
  password: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  shopName: string;
}
