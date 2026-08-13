import { OpenAILanguageModelProvider } from './openai-language-model-provider';

export type LanguageModelProviderDescriptor = Readonly<{
  maxInputCharacters: number;
  maxOutputCharacters: number;
  modelKey: string;
  modelVersion: string;
  providerKey: string;
  timeoutMs: number;
}>;

export type LanguageModelCitationInput = Readonly<{
  citationId: string;
  text: string;
}>;

export type LanguageModelHistoryMessage = Readonly<{
  content: string;
  role: 'assistant' | 'user';
}>;

export type LanguageModelRequest = Readonly<{
  context: string;
  citations: readonly LanguageModelCitationInput[];
  history: readonly LanguageModelHistoryMessage[];
  userMessage: string;
}>;

export type LanguageModelResponse = Readonly<{
  attemptCount?: number;
  citationIds: readonly string[];
  durationMs?: number;
  inputTokens?: number;
  modelKey?: string;
  outputTokens?: number;
  providerRequestId?: string;
  text: string;
  totalTokens?: number;
}>;

export interface LanguageModelProvider extends LanguageModelProviderDescriptor {
  generate(
    request: LanguageModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<LanguageModelResponse>;
}

export class LanguageModelProviderError extends Error {
  readonly attempts?: number;
  readonly code: string;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    code: string,
    retryable = false,
    metadata: Readonly<{
      attempts?: number;
      providerRequestId?: string;
      status?: number;
    }> = {},
  ) {
    super(message);
    this.attempts = metadata.attempts;
    this.code = code;
    this.providerRequestId = metadata.providerRequestId;
    this.retryable = retryable;
    this.status = metadata.status;
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Array.from(text).length / 4));
}

function validateDescriptor(provider: LanguageModelProviderDescriptor): void {
  for (const value of [provider.providerKey, provider.modelKey, provider.modelVersion]) {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value)) {
      throw new LanguageModelProviderError(
        'Language model provider identity is invalid.',
        'provider_configuration_invalid',
      );
    }
  }
  for (const value of [
    provider.maxInputCharacters,
    provider.maxOutputCharacters,
    provider.timeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new LanguageModelProviderError(
        'Language model provider limits must be positive integers.',
        'provider_configuration_invalid',
      );
    }
  }
}

export class DeterministicFakeLanguageModelProvider implements LanguageModelProvider {
  readonly providerKey = 'local';
  readonly modelKey = 'deterministic-grounded-answer';
  readonly modelVersion = '1.0.0';
  readonly maxInputCharacters = 20_000;
  readonly maxOutputCharacters = 2_000;
  readonly timeoutMs = 3_000;
  readonly #failureMessage: string | undefined;

  constructor(options: Readonly<{ failureMessage?: string }> = {}) {
    validateDescriptor(this);
    this.#failureMessage = options.failureMessage;
  }

  async generate(
    request: LanguageModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<LanguageModelResponse> {
    if (options?.signal?.aborted) {
      throw new LanguageModelProviderError('Generation was aborted.', 'provider_aborted', true);
    }
    if (this.#failureMessage && request.userMessage === this.#failureMessage) {
      throw new LanguageModelProviderError(
        'Deterministic provider failure.',
        'provider_unavailable',
        true,
      );
    }
    const inputCharacters =
      request.userMessage.length +
      request.context.length +
      request.history.reduce((total, message) => total + message.content.length, 0);
    if (request.userMessage.length < 1 || inputCharacters > this.maxInputCharacters) {
      throw new LanguageModelProviderError(
        'The generation input exceeds the configured provider limit.',
        'provider_input_limit',
      );
    }
    const selected = request.citations.slice(0, 3);
    const text = selected.length
      ? `Grounded response: ${selected
          .map((citation) => citation.text)
          .join(' ')
          .slice(0, 1_800)}`
      : 'No grounded Knowledge context is available for this question.';
    return {
      citationIds: selected.map((citation) => citation.citationId),
      inputTokens: estimateTokens(
        `${request.history.map((message) => message.content).join('\n')}${request.userMessage}${request.context}`,
      ),
      outputTokens: estimateTokens(text),
      text,
    };
  }
}

class UnavailableLanguageModelProvider implements LanguageModelProvider {
  readonly providerKey = 'unconfigured';
  readonly modelKey = 'unavailable';
  readonly modelVersion = '1.0.0';
  readonly maxInputCharacters = 20_000;
  readonly maxOutputCharacters = 2_000;
  readonly timeoutMs = 1;
  readonly #code: string;

  constructor(code = 'provider_not_configured') {
    this.#code = code;
  }

  async generate(): Promise<never> {
    throw new LanguageModelProviderError(
      'No production language-model provider is configured.',
      this.#code,
    );
  }
}

export class LanguageModelProviderRegistry {
  readonly #current: LanguageModelProvider;

  constructor(current: LanguageModelProvider) {
    validateDescriptor(current);
    this.#current = current;
  }

  getCurrent(): LanguageModelProvider {
    return this.#current;
  }
}

export function createDefaultLanguageModelProviderRegistry(
  options: Readonly<{
    configuredProvider?: string;
    deterministicFailureMessage?: string;
    model?: string;
    openAiApiKey?: string;
    openAiFetch?: typeof globalThis.fetch;
    runtime?: string;
  }> = {},
): LanguageModelProviderRegistry {
  const configuredProvider = options.configuredProvider ?? process.env.AI_PROVIDER;
  const runtime = options.runtime ?? process.env.NODE_ENV;
  const key =
    configuredProvider === undefined ? undefined : configuredProvider.trim().toLowerCase();

  if ((key === undefined || key === 'local') && runtime !== 'production') {
    return new LanguageModelProviderRegistry(
      new DeterministicFakeLanguageModelProvider({
        failureMessage: options.deterministicFailureMessage ?? process.env.AI_LOCAL_FAILURE_MESSAGE,
      }),
    );
  }

  if (key === 'openai') {
    const model = (options.model ?? process.env.AI_MODEL)?.trim();
    const apiKey = (options.openAiApiKey ?? process.env.OPENAI_API_KEY)?.trim();
    if (!model || !apiKey) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_configuration_invalid'),
      );
    }
    if (runtime !== 'production' && !options.openAiFetch) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_network_disabled'),
      );
    }
    try {
      return new LanguageModelProviderRegistry(
        new OpenAILanguageModelProvider({
          apiKey,
          fetch: options.openAiFetch,
          model,
          runtime,
        }),
      );
    } catch (error) {
      if (
        error instanceof LanguageModelProviderError &&
        error.code === 'provider_configuration_invalid'
      ) {
        return new LanguageModelProviderRegistry(
          new UnavailableLanguageModelProvider('provider_configuration_invalid'),
        );
      }
      throw error;
    }
  }

  return new LanguageModelProviderRegistry(
    new UnavailableLanguageModelProvider(
      key === 'local' || key === undefined
        ? 'provider_not_configured'
        : 'provider_configuration_invalid',
    ),
  );
}
