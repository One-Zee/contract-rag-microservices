import {
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
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
  Roles,
  RolesGuard,
  UserDto,
  type GetUserRpcPayload,
} from '@app/common';
import { AUTH_CLIENT } from '../clients/auth-client.module.js';
import { rpcToHttp } from '../common/rpc-to-http.js';
import { AccessToken } from '../auth/access-token.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(@Inject(AUTH_CLIENT) private readonly authClient: ClientProxy) {}

  /**
   * `@Roles('admin')` here is a **coarse, cheap check** against the claims that
   * saves a network hop. The authoritative decision is made in `auth-service`,
   * which repeats the same check against a token it verifies itself (ADR 006).
   */
  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'List users (admin only)' })
  @ApiResponse({ status: 200, type: [UserDto] })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  list(@AccessToken() accessToken: string): Observable<UserDto[]> {
    return this.authClient
      .send<UserDto[]>(AUTH_PATTERNS.USER_LIST, { accessToken })
      .pipe(rpcToHttp());
  }

  /**
   * Deliberately **without** an ownership check in the gateway.
   *
   * The gateway does not know who owns the record until it reads it, and reading
   * is exactly what is being authorized. The service that owns the resource
   * makes the call — your own account for anyone, someone else's for admins only.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'A single user — your own account, or any account for an admin',
  })
  @ApiResponse({ status: 200, type: UserDto })
  @ApiResponse({
    status: 403,
    description: "Someone else's account without the admin role",
  })
  @ApiResponse({ status: 404, description: 'User does not exist' })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @AccessToken() accessToken: string,
  ): Observable<UserDto> {
    return this.authClient
      .send<UserDto>(AUTH_PATTERNS.USER_GET, {
        accessToken,
        userId: id,
      } satisfies GetUserRpcPayload)
      .pipe(rpcToHttp());
  }
}
