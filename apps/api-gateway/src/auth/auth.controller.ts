import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import {
  AUTH_PATTERNS,
  type AuthContext,
  AuthTokensDto,
  CurrentUser,
  LoginDto,
  RefreshTokenDto,
  RegisterDto,
} from '@app/common';
import { AUTH_CLIENT } from '../clients/auth-client.module.js';
import { rpcToHttp } from '../common/rpc-to-http.js';
import { StrictThrottle } from '../throttling/throttling.options.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AUTH_CLIENT) private readonly authClient: ClientProxy) {}

  @Post('register')
  @StrictThrottle()
  @ApiOperation({
    summary: 'Registers a user and immediately issues a token pair',
  })
  @ApiResponse({ status: 201, type: AuthTokensDto })
  @ApiResponse({ status: 403, description: 'Registration is closed' })
  @ApiResponse({ status: 409, description: 'E-mail already taken' })
  @ApiResponse({
    status: 429,
    description: 'Too many attempts from this address',
  })
  register(@Body() dto: RegisterDto): Observable<AuthTokensDto> {
    // The role is not taken from the request — the database assigns it (`reader`).
    return this.authClient
      .send<AuthTokensDto>(AUTH_PATTERNS.REGISTER, dto)
      .pipe(rpcToHttp());
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @StrictThrottle()
  @ApiOperation({ summary: 'Log in' })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid e-mail or password' })
  @ApiResponse({
    status: 429,
    description: 'Too many attempts from this address',
  })
  login(@Body() dto: LoginDto): Observable<AuthTokensDto> {
    return this.authClient
      .send<AuthTokensDto>(AUTH_PATTERNS.LOGIN, dto)
      .pipe(rpcToHttp());
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @StrictThrottle()
  @ApiOperation({
    summary: 'Rotates the refresh token',
    description:
      'The refresh token is single-use. Reusing an already-spent token revokes ' +
      "all of that user's active tokens (ADR 005).",
  })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, description: 'Invalid, expired or already used' })
  @ApiResponse({
    status: 429,
    description: 'Too many attempts from this address',
  })
  refresh(@Body() dto: RefreshTokenDto): Observable<AuthTokensDto> {
    return this.authClient
      .send<AuthTokensDto>(AUTH_PATTERNS.REFRESH, dto)
      .pipe(rpcToHttp());
  }

  /**
   * Returns the already-verified claims — **with no TCP call.**
   *
   * A call to `auth-service` here would be exactly the redundant hop the whole
   * architecture avoids: the signature is the proof of identity, and this route
   * needs nothing fresher. Anyone who needs the live database record goes to
   * `GET /users/:id`.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Identity from the token, without querying the service',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  me(@CurrentUser() user: AuthContext): AuthContext {
    return user;
  }
}
