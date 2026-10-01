import { ABSTAIN_REASONS, QUERY_STATUSES } from '@app/common';
import { abstainReason } from './answers.js';
import { queryStatus } from './queries.js';

/**
 * The service decides these values from the `@app/common` constants and the
 * database stores them as enums. A value added on one side and forgotten on
 * the other is an insert that fails at runtime, not a type error — so it is
 * checked here.
 */
describe('query log enums', () => {
  it('query_status matches QUERY_STATUSES from @app/common', () => {
    expect([...queryStatus.enumValues]).toEqual([...QUERY_STATUSES]);
  });

  it('abstain_reason matches ABSTAIN_REASONS from @app/common', () => {
    expect([...abstainReason.enumValues]).toEqual([...ABSTAIN_REASONS]);
  });
});
