import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { USER_ROLES, type UserRoleName } from '../auth/auth-context.js';

/**
 * The DTOs live in `@app/common` rather than in the gateway because both
 * services use them: the gateway for HTTP validation and Swagger,
 * `auth-service` as the type of the TCP payload. Were they in the gateway,
 * `auth-service` would have to import from `apps/api-gateway/` and break the
 * `no-cross-app-imports` rule (ADR 002).
 */

/**
 * The password upper bound is not arbitrary: **bcrypt silently truncates
 * anything past 72 bytes.** Without it two different long passwords would share
 * a hash and a user could log in with the wrong one — so it is rejected instead
 * of quietly cut short.
 */
const PASSWORD_MAX = 72;
const PASSWORD_MIN = 12;

export class RegisterDto {
  @ApiProperty({ example: 'analiticar@clauseiq.ba' })
  @IsEmail({}, { message: 'email must be a valid e-mail address' })
  email: string;

  @ApiProperty({ minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX })
  @IsString()
  @MinLength(PASSWORD_MIN, {
    message: `password must be at least ${PASSWORD_MIN} characters`,
  })
  @MaxLength(PASSWORD_MAX, {
    message: `password must not exceed ${PASSWORD_MAX} bytes (bcrypt limit)`,
  })
  password: string;

  @ApiPropertyOptional({ example: 'Amina Hadžić' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;
}

export class LoginDto {
  @ApiProperty({ example: 'analiticar@clauseiq.ba' })
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(PASSWORD_MAX)
  password: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token issued at login or by a previous refresh' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class UserDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  email: string;

  @ApiPropertyOptional({ nullable: true })
  fullName: string | null;

  @ApiProperty({ enum: USER_ROLES })
  role: UserRoleName;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class AuthTokensDto {
  @ApiProperty({ description: 'RS256 JWT, valid for JWT_EXPIRES_IN (15m by default)' })
  accessToken: string;

  @ApiProperty({
    description:
      'Opaque, single-use — every refresh revokes the previous one (ADR 005)',
  })
  refreshToken: string;

  @ApiProperty({ type: UserDto })
  user: UserDto;
}
