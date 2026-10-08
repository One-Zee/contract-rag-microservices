import { Logger } from '@nestjs/common';
import type { AppConfigService } from '@app/config';
import { AnthropicProvider } from './anthropic.provider.js';
import { FakeLlmProvider } from './fake.provider.js';
import { createLlmProvider } from './llm.module.js';
import { OllamaProvider } from './ollama.provider.js';

Logger.overrideLogger(false);

const config = (overrides: Partial<AppConfigService>): AppConfigService =>
  ({
    llmProvider: 'ollama',
    llmModel: 'llama3.1:8b',
    anthropicApiKey: 'sk-ant-key',
    anthropicVersion: '2023-06-01',
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    llmIdleTimeoutMs: 60_000,
    ...overrides,
  }) as AppConfigService;

describe('createLlmProvider', () => {
  it('builds the local provider by default', () => {
    const provider = createLlmProvider(config({}));

    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('llama3.1:8b');
  });

  it('builds the Anthropic provider with the configured model', () => {
    const provider = createLlmProvider(
      config({ llmProvider: 'anthropic', llmModel: 'claude-haiku-4-5' }),
    );

    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.model).toBe('claude-haiku-4-5');
  });

  it('builds the fake provider for tests', () => {
    const provider = createLlmProvider(
      config({ llmProvider: 'fake', llmModel: 'fake-legal-assistant' }),
    );

    expect(provider).toBeInstanceOf(FakeLlmProvider);
    expect(provider.name).toBe('fake');
  });

  // The schema only requires ANTHROPIC_API_KEY when the provider is
  // `anthropic`, so reading it for any other provider would turn a valid
  // environment into a boot failure.
  it('builds a keyless provider without touching ANTHROPIC_API_KEY', () => {
    // A getter, not a spread value: the real service throws when the key is
    // absent, and for these two providers it is. (Spreading would read it.)
    const noKey = (provider: 'ollama' | 'fake'): AppConfigService =>
      ({
        llmProvider: provider,
        llmModel: 'llama3.1:8b',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        llmIdleTimeoutMs: 60_000,
        get anthropicApiKey(): string {
          throw new Error(
            `ANTHROPIC_API_KEY must not be read for \`${provider}\``,
          );
        },
      }) as AppConfigService;

    expect(createLlmProvider(noKey('ollama'))).toBeInstanceOf(OllamaProvider);
    expect(createLlmProvider(noKey('fake'))).toBeInstanceOf(FakeLlmProvider);
  });

  it('rejects a provider name the schema would never let through', () => {
    expect(() =>
      createLlmProvider(config({ llmProvider: 'openai' as 'anthropic' })),
    ).toThrow('Unknown LLM provider: openai');
  });
});
