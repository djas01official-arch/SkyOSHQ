import {
  OPENAI_APPROVED_MODEL,
  OpenAILanguageModelProvider,
} from './openai-language-model-provider';
import {
  ANTHROPIC_APPROVED_MODELS,
  AnthropicLanguageModelProvider,
} from './anthropic-language-model-provider';
import {
  GEMINI_APPROVED_MODELS,
  GeminiLanguageModelProvider,
  type GeminiInteractionClient,
} from './gemini-language-model-provider';
import type { AiProviderExecutionLimits } from './ai-execution-limits';
import type {
  AiBoundProviderInputTokenMeasurement,
  AiProviderInputTokenMeasurementIdentity,
} from './ai-input-token-measurement';

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

export type LanguageModelResponseFormat =
  | 'grounded_answer'
  | 'knowledge_summary'
  | 'knowledge_action_items'
  | 'knowledge_risks'
  | 'knowledge_key_decisions';

export type LanguageModelRequest = Readonly<{
  context: string;
  citations: readonly LanguageModelCitationInput[];
  executionLimits?: AiProviderExecutionLimits;
  history: readonly LanguageModelHistoryMessage[];
  responseFormat?: LanguageModelResponseFormat;
  userMessage: string;
}>;

export type LanguageModelResponse = Readonly<{
  attemptCount?: number;
  cacheWrite1HourInputTokens?: number;
  cacheWriteInputTokens?: number;
  cachedInputTokens?: number;
  citationIds: readonly string[];
  durationMs?: number;
  inferenceGeo?: 'global' | 'us';
  inputTokens?: number;
  modelKey?: string;
  outputTokens?: number;
  providerRequestId?: string;
  reasoningTokens?: number;
  text: string;
  totalTokens?: number;
}>;

export type AiProviderInputTokenMeasurementAccounting =
  'DOCUMENTED_NO_ADDITIONAL_CHARGE' | 'NO_PROVIDER_CALL' | 'UNRESOLVED';

export interface LanguageModelProvider extends LanguageModelProviderDescriptor {
  readonly inputTokenMeasurementAccounting?: AiProviderInputTokenMeasurementAccounting;
  generate(
    request: LanguageModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<LanguageModelResponse>;
  measureInputTokens?(
    request: LanguageModelRequest,
    identity: AiProviderInputTokenMeasurementIdentity,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AiBoundProviderInputTokenMeasurement>;
}

export class LanguageModelProviderError extends Error {
  readonly attempts?: number;
  readonly code: string;
  readonly providerDiagnosticCode?: string;
  readonly providerRequestId?: string;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    code: string,
    retryable = false,
    metadata: Readonly<{
      attempts?: number;
      providerDiagnosticCode?: string;
      providerRequestId?: string;
      status?: number;
    }> = {},
  ) {
    super(message);
    this.attempts = metadata.attempts;
    this.code = code;
    this.providerDiagnosticCode = metadata.providerDiagnosticCode;
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
  readonly errorCode: string;

  constructor(code = 'provider_not_configured') {
    this.errorCode = code;
  }

  async generate(): Promise<never> {
    throw new LanguageModelProviderError(
      'No production language-model provider is configured.',
      this.errorCode,
    );
  }
}

export class LanguageModelProviderRegistry {
  readonly #current: LanguageModelProvider;
  readonly #providers: ReadonlyMap<string, LanguageModelProvider>;

  constructor(current: LanguageModelProvider, peers: readonly LanguageModelProvider[] = []) {
    const providers = new Map<string, LanguageModelProvider>();
    for (const provider of [current, ...peers]) {
      validateDescriptor(provider);
      const key = LanguageModelProviderRegistry.key(provider);
      if (providers.has(key)) {
        throw new LanguageModelProviderError(
          'Language model provider identities must be unique.',
          'provider_configuration_invalid',
        );
      }
      providers.set(key, provider);
    }
    this.#current = current;
    this.#providers = providers;
  }

  getCurrent(): LanguageModelProvider {
    return this.#current;
  }

  getVersion(providerKey: string, modelKey: string, modelVersion: string): LanguageModelProvider {
    const provider = this.#providers.get(
      LanguageModelProviderRegistry.key({ modelKey, modelVersion, providerKey }),
    );
    if (!provider) {
      throw new LanguageModelProviderError(
        'The requested language model provider version is not registered.',
        this.#current instanceof UnavailableLanguageModelProvider
          ? this.#current.errorCode
          : 'provider_not_configured',
      );
    }
    return provider;
  }

  list(): readonly LanguageModelProvider[] {
    return [...this.#providers.values()];
  }

  private static key(
    provider: Pick<LanguageModelProviderDescriptor, 'modelKey' | 'modelVersion' | 'providerKey'>,
  ): string {
    return `${provider.providerKey}\0${provider.modelKey}\0${provider.modelVersion}`;
  }
}

export function createDefaultLanguageModelProviderRegistry(
  options: Readonly<{
    configuredProvider?: string;
    anthropicApiKey?: string;
    anthropicFetch?: typeof globalThis.fetch;
    chatMode?: string;
    deterministicFailureMessage?: string;
    geminiApiKey?: string;
    geminiInteractionClient?: GeminiInteractionClient;
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

  const chatMode = (options.chatMode ?? process.env.AI_CHAT_MODE)?.trim().toUpperCase();
  if (
    chatMode === 'AUTO' ||
    chatMode === 'BALANCED' ||
    chatMode === 'DEEP' ||
    chatMode === 'CRITICAL'
  ) {
    const model = (options.model ?? process.env.AI_MODEL)?.trim();
    const openAiApiKey = (options.openAiApiKey ?? process.env.OPENAI_API_KEY)?.trim();
    const anthropicApiKey = (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
    const geminiApiKey = (options.geminiApiKey ?? process.env.GEMINI_API_KEY)?.trim();
    if (!model || !openAiApiKey || !anthropicApiKey || !geminiApiKey) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_configuration_invalid'),
      );
    }
    if (
      runtime !== 'production' &&
      (!options.openAiFetch || !options.anthropicFetch || !options.geminiInteractionClient)
    ) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_network_disabled'),
      );
    }
    try {
      const providers: LanguageModelProvider[] = [
        new OpenAILanguageModelProvider({
          apiKey: openAiApiKey,
          fetch: options.openAiFetch,
          model: OPENAI_APPROVED_MODEL,
          runtime,
        }),
        ...ANTHROPIC_APPROVED_MODELS.map(
          (approvedModel) =>
            new AnthropicLanguageModelProvider({
              apiKey: anthropicApiKey,
              fetch: options.anthropicFetch,
              model: approvedModel,
              runtime,
            }),
        ),
        ...GEMINI_APPROVED_MODELS.map(
          (approvedModel) =>
            new GeminiLanguageModelProvider({
              apiKey: geminiApiKey,
              interactionClient: options.geminiInteractionClient,
              model: approvedModel,
              runtime,
            }),
        ),
      ];
      const current = providers.find(
        (provider) => provider.providerKey === key && provider.modelKey === model,
      );
      if (!current) {
        return new LanguageModelProviderRegistry(
          new UnavailableLanguageModelProvider('provider_configuration_invalid'),
        );
      }
      return new LanguageModelProviderRegistry(
        current,
        providers.filter((provider) => provider !== current),
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

  if (key === 'anthropic') {
    const model = (options.model ?? process.env.AI_MODEL)?.trim();
    const apiKey = (options.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY)?.trim();
    if (!model || !apiKey) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_configuration_invalid'),
      );
    }
    if (runtime !== 'production' && !options.anthropicFetch) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_network_disabled'),
      );
    }
    try {
      const approvedProviders = ANTHROPIC_APPROVED_MODELS.map(
        (approvedModel) =>
          new AnthropicLanguageModelProvider({
            apiKey,
            fetch: options.anthropicFetch,
            model: approvedModel,
            runtime,
          }),
      );
      const current = approvedProviders.find((provider) => provider.modelKey === model);
      if (!current) {
        return new LanguageModelProviderRegistry(
          new UnavailableLanguageModelProvider('provider_configuration_invalid'),
        );
      }
      return new LanguageModelProviderRegistry(
        current,
        approvedProviders.filter((provider) => provider !== current),
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

  if (key === 'gemini') {
    const model = (options.model ?? process.env.AI_MODEL)?.trim();
    const apiKey = (options.geminiApiKey ?? process.env.GEMINI_API_KEY)?.trim();
    if (!model || !apiKey) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_configuration_invalid'),
      );
    }
    if (runtime !== 'production' && !options.geminiInteractionClient) {
      return new LanguageModelProviderRegistry(
        new UnavailableLanguageModelProvider('provider_network_disabled'),
      );
    }
    try {
      const approvedProviders = GEMINI_APPROVED_MODELS.map(
        (approvedModel) =>
          new GeminiLanguageModelProvider({
            apiKey,
            interactionClient: options.geminiInteractionClient,
            model: approvedModel,
            runtime,
          }),
      );
      const current = approvedProviders.find((provider) => provider.modelKey === model);
      if (!current) {
        return new LanguageModelProviderRegistry(
          new UnavailableLanguageModelProvider('provider_configuration_invalid'),
        );
      }
      return new LanguageModelProviderRegistry(
        current,
        approvedProviders.filter((provider) => provider !== current),
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
