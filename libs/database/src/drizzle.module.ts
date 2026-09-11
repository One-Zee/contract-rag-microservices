import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigModule, AppConfigService } from '@app/config';
import * as schema from './schema/index.js';

/**
 * There is no official Drizzle module for NestJS, so this is the dozen lines
 * from plan.md §6.4 — and a concrete example of the `useFactory` pattern for
 * chapter 2.2.1.
 */
export const DRIZZLE = Symbol('DRIZZLE');
const PG_POOL = Symbol('PG_POOL');

export type DrizzleDatabase = NodePgDatabase<typeof schema>;

@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new Pool({ connectionString: config.databaseUrl }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool): DrizzleDatabase => drizzle(pool, { schema }),
    },
  ],
  exports: [DRIZZLE],
})
export class DrizzleModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * The pool holds open sockets, so without this `app.close()` never frees the
   * event loop — the process stays alive and the e2e test hangs instead of
   * finishing.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
