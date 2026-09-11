import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDatabase, users } from '@app/database';
import type { UserRoleName } from '@app/common';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string | null;
  role: UserRoleName;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  fullName?: string | null;
}

/**
 * A thin layer over Drizzle. It exists so `AuthService` depends on this
 * interface rather than on the database — unit tests replace it with an object
 * of `vi.fn()`s and cover the business rules without a single SQL query.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  async findByEmail(email: string): Promise<UserRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<UserRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const [row] = await this.db
      .insert(users)
      .values({
        email: input.email,
        passwordHash: input.passwordHash,
        fullName: input.fullName ?? null,
      })
      .returning();
    return row;
  }

  async list(): Promise<UserRecord[]> {
    return this.db.select().from(users).orderBy(asc(users.createdAt));
  }
}
