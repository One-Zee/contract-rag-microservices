import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { AppConfigModule, baseSchema, databaseSchema } from '@app/config';
import { DrizzleModule } from './drizzle.module.js';

process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/unused';

const fakePool = () =>
  ({ end: vi.fn().mockResolvedValue(undefined) }) as unknown as Pool;

describe('DrizzleModule', () => {
  it('closes the pool when the application shuts down', async () => {
    const end = vi.spyOn(Pool.prototype, 'end').mockResolvedValue(undefined);

    const app = await Test.createTestingModule({
      imports: [
        AppConfigModule.forRoot(baseSchema.concat(databaseSchema)),
        DrizzleModule,
      ],
    }).compile();
    await app.init();

    expect(end).not.toHaveBeenCalled();

    await app.close();

    expect(end).toHaveBeenCalledTimes(1);
    end.mockRestore();
  });

  it('closes the pool only once', async () => {
    const pool = fakePool();
    const module = new DrizzleModule(pool);

    await module.onApplicationShutdown();
    await expect(module.onApplicationShutdown()).resolves.toBeUndefined();

    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
