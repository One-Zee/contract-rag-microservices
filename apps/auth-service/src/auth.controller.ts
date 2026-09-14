import { Controller, UseGuards } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AUTH_PATTERNS,
  type AuthContext,
  type AuthTokensDto,
  CurrentUser,
  type GetUserRpcPayload,
  type LoginDto,
  type RefreshTokenDto,
  type RegisterDto,
  Roles,
  RolesGuard,
  RpcAuthGuard,
  type UserDto,
} from '@app/common';
import { AuthService } from './auth.service.js';

/**
 * TCP handlers. The service has no HTTP layer — the only way in is
 * `@MessagePattern`, and only from the private network (see `main.ts`).
 *
 * The first three routes are public: they are the only operations performed
 * **before** a user has a token. Everything else goes through `RpcAuthGuard`,
 * which verifies the token **again** even though the gateway already checked it
 * — the service does not assume the caller is the gateway (ADR 006).
 */
@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @MessagePattern(AUTH_PATTERNS.REGISTER)
  register(@Payload() dto: RegisterDto): Promise<AuthTokensDto> {
    return this.authService.register(dto);
  }

  @MessagePattern(AUTH_PATTERNS.LOGIN)
  login(@Payload() dto: LoginDto): Promise<AuthTokensDto> {
    return this.authService.login(dto);
  }

  @MessagePattern(AUTH_PATTERNS.REFRESH)
  refresh(@Payload() dto: RefreshTokenDto): Promise<AuthTokensDto> {
    return this.authService.refresh(dto);
  }

  /**
   * The role check is repeated here even though the gateway already did it.
   * That is not redundancy: the gateway is the first, cheap filter, while the
   * authoritative decision is made here — OWASP defence in depth, three layers.
   */
  @UseGuards(RpcAuthGuard, RolesGuard)
  @Roles('admin')
  @MessagePattern(AUTH_PATTERNS.USER_LIST)
  listUsers(): Promise<UserDto[]> {
    return this.authService.listUsers();
  }

  /**
   * Ownership cannot be checked by a decorator because it depends on data that
   * has yet to be read — so `AuthService.getUser` makes that call.
   */
  @UseGuards(RpcAuthGuard)
  @MessagePattern(AUTH_PATTERNS.USER_GET)
  getUser(
    @Payload() payload: GetUserRpcPayload,
    @CurrentUser() auth: AuthContext,
  ): Promise<UserDto> {
    return this.authService.getUser(auth, payload.userId);
  }
}
