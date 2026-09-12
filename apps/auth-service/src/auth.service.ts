import { Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcrypt';
import {
  type AuthContext,
  type AuthTokensDto,
  type LoginDto,
  type RefreshTokenDto,
  type RegisterDto,
  type UserDto,
  rpcConflict,
  rpcForbidden,
  rpcNotFound,
  rpcUnauthorized,
} from '@app/common';
import { TokenService } from './token.service.js';
import {
  UsersRepository,
  type UserRecord,
} from './repositories/users.repository.js';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository.js';

const BCRYPT_ROUNDS = 12;
const INVALID_CREDENTIALS = 'Invalid e-mail or password';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthTokensDto> {
    const email = AuthService.normalizeEmail(dto.email);

    if (await this.users.findByEmail(email)) {
      throw rpcConflict('A user with this e-mail address already exists');
    }

    const user = await this.users.create({
      email,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS),
      fullName: dto.fullName ?? null,
    });

    // The role is never taken from the request. The database assigns `reader`
    // as the default — otherwise anyone could register themselves as an admin.
    return this.issueTokens(user);
  }

  async login(dto: LoginDto): Promise<AuthTokensDto> {
    const user = await this.users.findByEmail(
      AuthService.normalizeEmail(dto.email),
    );

    // The comparison runs even when the user does not exist — otherwise the
    // difference in response time would reveal which addresses exist.
    const hash = user?.passwordHash ?? DUMMY_HASH;
    const matches = await bcrypt.compare(dto.password, hash);

    if (!user || !matches) {
      throw rpcUnauthorized(INVALID_CREDENTIALS);
    }
    return this.issueTokens(user);
  }

  /**
   * Refresh token rotation with reuse detection.
   */
  async refresh(dto: RefreshTokenDto): Promise<AuthTokensDto> {
    const record = await this.refreshTokens.findByHash(
      TokenService.hash(dto.refreshToken),
    );

    if (!record) {
      throw rpcUnauthorized('Invalid refresh token');
    }

    if (record.revokedAt) {
      const revoked = await this.refreshTokens.revokeAllForUser(record.userId);
      this.logger.warn(
        `Refresh token reuse detected for user ${record.userId} — ` +
          `revoked ${revoked} active tokens`,
      );
      throw rpcUnauthorized('Refresh token has already been used');
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      throw rpcUnauthorized('Refresh token has expired');
    }

    const user = await this.users.findById(record.userId);
    if (!user) {
      throw rpcUnauthorized('Invalid refresh token');
    }

    const [accessToken, refresh] = await Promise.all([
      this.tokens.signAccessToken(user),
      this.tokens.issueRefreshToken(user.id),
    ]);

    // Only now is the old one revoked, with a pointer to its successor. The
    // order matters: revoking before the new one exists would leave the user
    // with no valid token at all if the insert failed.
    await this.refreshTokens.revoke(record.id, refresh.id);

    return {
      accessToken,
      refreshToken: refresh.token,
      user: AuthService.toUserDto(user),
    };
  }

  /**
   * The ownership check — **business authorization that lives in the service
   * owning the resource**, not in the gateway.
   *
   * The gateway cannot make this call: it does not know who owns the record
   * until it reads it, and reading is exactly what is being authorized (ADR 006).
   */
  async getUser(auth: AuthContext, userId: string): Promise<UserDto> {
    const isSelf = auth.userId === userId;
    const isAdmin = auth.roles.includes('admin');

    if (!isSelf && !isAdmin) {
      throw rpcForbidden('You may only access your own account');
    }

    const user = await this.users.findById(userId);
    if (!user) {
      throw rpcNotFound('User does not exist');
    }
    return AuthService.toUserDto(user);
  }

  async listUsers(): Promise<UserDto[]> {
    const rows = await this.users.list();
    return rows.map(AuthService.toUserDto);
  }

  private async issueTokens(user: UserRecord): Promise<AuthTokensDto> {
    const [accessToken, refresh] = await Promise.all([
      this.tokens.signAccessToken(user),
      this.tokens.issueRefreshToken(user.id),
    ]);
    return {
      accessToken,
      refreshToken: refresh.token,
      user: AuthService.toUserDto(user),
    };
  }

  private static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** `passwordHash` never leaves the service. */
  private static toUserDto(user: UserRecord): UserDto {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}

/**
 * A valid bcrypt hash of no particular password. Its only job is to give
 * `bcrypt.compare` the same work to do when the user does not exist, so response
 * time does not reveal whether an account is there.
 */
const DUMMY_HASH =
  '$2b$12$C6UzMDM.H6dfI/f/IKcEe.mTC0BUR3vHhwWQ7hnrOCVOgWCwFTLGm';
