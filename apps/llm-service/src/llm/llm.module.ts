import { Logger, Module } from '@nestjs/common';
import { AppConfigService } from '@app/config';
import { AnthropicProvider } from './anthropic.provider.js';
import { FakeLlmProvider } from './fake.provider.js';
import { LLM, type LlmProvider } from './llm-provider.js';
import { OllamaProvider } from './ollama.provider.js';

/**
 * Builds the provider `LLM_PROVIDER` names. Exported on its own so a test can
 * exercise the choice without booting a Nest context — the same arrangement as
 * `createEmbeddingProvider` and `createReranker`.
 */
export function createLlmProvider(config: AppConfigService): LlmProvider {
  const name = config.llmProvider;
  const model = config.llmModel;
  let provider: LlmProvider;

  switch (name) {
    case 'anthropic':
      provider = new AnthropicProvider({
        // Read inside the branch, never before it: `getOrThrow` on a key that
        // the schema only requires for this provider would otherwise break
        // every other provider's boot.
        apiKey: config.anthropicApiKey,
        model,
        version: config.anthropicVersion,
        idleTimeoutMs: config.llmIdleTimeoutMs,
      });
      break;
    case 'ollama':
      provider = new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model,
        idleTimeoutMs: config.llmIdleTimeoutMs,
      });
      break;
    case 'fake':
      provider = new FakeLlmProvider(model);
      break;
    default: {
      // The schema only lets the three above through; this is the type-level
      // guarantee that adding a fourth name means adding a case here.
      const unknown: never = name;
      throw new Error(`Unknown LLM provider: ${String(unknown)}`);
    }
  }

  new Logger(LlmModule.name).log(`LLM: ${provider.name}/${provider.model}`);
  return provider;
}

/**
 * One `LlmProvider` per process, chosen from the environment. Not `@Global()`:
 * a service that generates says so in its imports.
 */
@Module({
  providers: [
    { provide: LLM, inject: [AppConfigService], useFactory: createLlmProvider },
  ],
  exports: [LLM],
})
export class LlmModule {}
