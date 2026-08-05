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

export type LanguageModelRequest = Readonly<{
  context: string;
  citations: readonly LanguageModelCitationInput[];
  userMessage: string;
}>;

export type LanguageModelResponse = Readonly<{
  citationIds: readonly string[];
  inputTokens?: number;
  outputTokens?: number;
  text: string;
}>;

export interface LanguageModelProvider extends LanguageModelProviderDescriptor {
  generate(
    request: LanguageModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<LanguageModelResponse>;
}

export class LanguageModelProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
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

  constructor() {
    validateDescriptor(this);
  }

  async generate(
    request: LanguageModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<LanguageModelResponse> {
    if (options?.signal?.aborted) {
      throw new LanguageModelProviderError('Generation was aborted.', 'provider_aborted', true);
    }
    if (
      request.userMessage.length < 1 ||
      request.userMessage.length + request.context.length > this.maxInputCharacters
    ) {
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
      inputTokens: estimateTokens(request.userMessage + request.context),
      outputTokens: estimateTokens(text),
      text,
    };
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
  configuredProvider = process.env.AI_PROVIDER,
): LanguageModelProviderRegistry {
  const local = new DeterministicFakeLanguageModelProvider();
  const key = configuredProvider?.trim().toLowerCase() || local.providerKey;
  if (key !== local.providerKey) {
    throw new LanguageModelProviderError(
      `AI provider "${key}" is not configured. Use "local" or install a validated provider adapter.`,
      'provider_not_configured',
    );
  }
  return new LanguageModelProviderRegistry(local);
}
