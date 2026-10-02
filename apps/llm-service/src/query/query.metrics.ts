import type { Counter, Histogram } from '@opentelemetry/api';
import { getMeter } from '@app/telemetry';

/**
 * What a dashboard needs to watch while a load test runs. The `queries` and
 * `answers` tables stay the source of truth for every figure in the thesis
 * (ADR 018); these exist because a table cannot be watched live, and because
 * time to first token is recorded nowhere else.
 *
 * Names follow the OpenTelemetry GenAI conventions where one exists; the two
 * `clauseiq.*` ones have no convention to follow.
 */
interface QueryInstruments {
  /** Seconds from the request to the end of the stream, per call. */
  operationDuration: Histogram;
  /** Tokens per call, `gen_ai.token.type` = input | output. */
  tokenUsage: Histogram;
  /** Seconds from the request to the first text fragment. */
  timeToFirstToken: Histogram;
  /** Every finished query, by status and abstention reason. */
  outcomes: Counter;
}

// Seconds. A streamed answer runs for tens of seconds; the default buckets
// are tuned for milliseconds.
const LLM_SECONDS = [0.1, 0.25, 0.5, 1, 2, 4, 8, 15, 30, 60, 120];
const TOKENS = [16, 64, 256, 1024, 4096, 16_384, 65_536];

let instruments: QueryInstruments | undefined;

/** Created on first use — after the SDK has started, never at import. */
export function queryInstruments(): QueryInstruments {
  if (!instruments) {
    const meter = getMeter();
    instruments = {
      operationDuration: meter.createHistogram(
        'gen_ai.client.operation.duration',
        {
          unit: 's',
          description: 'Duration of a model call, until the stream ended',
          advice: { explicitBucketBoundaries: LLM_SECONDS },
        },
      ),
      tokenUsage: meter.createHistogram('gen_ai.client.token.usage', {
        unit: '{token}',
        description:
          'Tokens used per model call, as the provider reported them',
        advice: { explicitBucketBoundaries: TOKENS },
      }),
      timeToFirstToken: meter.createHistogram(
        'clauseiq.llm.time_to_first_token',
        {
          unit: 's',
          description:
            'Seconds from sending the prompt to the first text fragment',
          advice: { explicitBucketBoundaries: LLM_SECONDS },
        },
      ),
      outcomes: meter.createCounter('clauseiq.query.outcomes', {
        description: 'Finished queries by status and abstention reason',
      }),
    };
  }
  return instruments;
}
