import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AppConfigModule, AppConfigService } from '@app/config';
import * as schema from './schema/index.js';

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
export class DrizzleModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DrizzleModule.name);
  private closed = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    await this.pool.end();
    this.logger.log('Postgres pool closed');
  }
}
