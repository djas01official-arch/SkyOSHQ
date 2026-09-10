import { createHash } from 'node:crypto';

import { GoogleGenAI } from '@google/genai';

export type EmbeddingProviderDescriptor = Readonly<{
  providerKey: string;
  modelKey: string;
  modelVersion: string;
  dimensions: number;
  maxInputCharacters: number;
  maxBatchSize: number;
}>;

export type EmbeddingTask = 'retrieval-document' | 'retrieval-query';

export type EmbeddingRequestOptions = Readonly<{
  signal?: AbortSignal;
  task?: EmbeddingTask;
}>;

export interface EmbeddingProvider extends EmbeddingProviderDescriptor {
  embed(
    inputs: readonly string[],
    options?: EmbeddingRequestOptions,
  ): Promise<readonly (readonly number[])[]>;
}

export class EmbeddingProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export class EmbeddingProviderRegistry {
  readonly #providers: Map<string, EmbeddingProvider>;
  readonly #currentKey: string;

  constructor(providers: readonly EmbeddingProvider[], current: EmbeddingProviderDescriptor) {
    this.#providers = new Map(
      providers.map((provider) => [
        EmbeddingProviderRegistry.key(
          provider.providerKey,
          provider.modelKey,
          provider.modelVersion,
        ),
        provider,
      ]),
    );
    this.#currentKey = EmbeddingProviderRegistry.key(
      current.providerKey,
      current.modelKey,
      current.modelVersion,
    );
    if (!this.#providers.has(this.#currentKey)) {
      throw new EmbeddingProviderError(
        'The current embedding provider is not registered.',
        'provider_not_registered',
      );
    }
  }

  static key(providerKey: string, modelKey: string, modelVersion: string): string {
    return `${providerKey}\0${modelKey}\0${modelVersion}`;
  }

  getCurrent(): EmbeddingProvider {
    return this.#providers.get(this.#currentKey)!;
  }

  getVersion(providerKey: string, modelKey: string, modelVersion: string): EmbeddingProvider {
    const provider = this.#providers.get(
      EmbeddingProviderRegistry.key(providerKey, modelKey, modelVersion),
    );
    if (!provider) {
      throw new EmbeddingProviderError(
        'The embedding provider version recorded for this job is unavailable.',
        'provider_version_unavailable',
      );
    }
    return provider;
  }
}

function validateDescriptor(descriptor: EmbeddingProviderDescriptor): void {
  for (const [name, value] of [
    ['providerKey', descriptor.providerKey],
    ['modelKey', descriptor.modelKey],
    ['modelVersion', descriptor.modelVersion],
  ] as const) {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value)) {
      throw new EmbeddingProviderError(`${name} is invalid.`, 'provider_configuration_invalid');
    }
  }
  if (
    !Number.isSafeInteger(descriptor.dimensions) ||
    descriptor.dimensions < 1 ||
    descriptor.dimensions > 2_000
  ) {
    throw new EmbeddingProviderError(
      'Embedding dimensions must be between 1 and 2000.',
      'provider_configuration_invalid',
    );
  }
  if (!Number.isSafeInteger(descriptor.maxInputCharacters) || descriptor.maxInputCharacters < 1) {
    throw new EmbeddingProviderError(
      'Embedding input limit must be a positive integer.',
      'provider_configuration_invalid',
    );
  }
  if (!Number.isSafeInteger(descriptor.maxBatchSize) || descriptor.maxBatchSize < 1) {
    throw new EmbeddingProviderError(
      'Embedding batch limit must be a positive integer.',
      'provider_configuration_invalid',
    );
  }
}

function featuresFor(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US');
  const words = normalized.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const features = [...words];
  for (const word of words) {
    if (word.length < 3) continue;
    for (let index = 0; index <= word.length - 3; index += 1) {
      features.push(`#${word.slice(index, index + 3)}`);
    }
  }
  return features.length > 0 ? features : [`raw:${normalized}`];
}

function deterministicVector(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const feature of featuresFor(text)) {
    const digest = createHash('sha256').update(feature, 'utf8').digest();
    for (let offset = 0; offset < digest.length; offset += 2) {
      const index = ((digest[offset] ?? 0) * 256 + (digest[offset + 1] ?? 0)) % dimensions;
      const sign = ((digest[(offset + 7) % digest.length] ?? 0) & 1) === 0 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingProviderError(
      'The deterministic embedding could not be normalized.',
      'embedding_normalization_failed',
    );
  }
  return vector.map((value) => value / norm);
}

export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
  readonly providerKey = 'local';
  readonly modelKey = 'deterministic-feature-hash';
  readonly modelVersion = '1.0.0';
  readonly dimensions = 64;
  readonly maxInputCharacters = 8_000;
  readonly maxBatchSize = 32;

  constructor() {
    validateDescriptor(this);
  }

  async embed(inputs: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (inputs.length < 1 || inputs.length > this.maxBatchSize) {
      throw new EmbeddingProviderError(
        `Embedding batches must contain between 1 and ${this.maxBatchSize} inputs.`,
        'batch_size_invalid',
      );
    }
    return inputs.map((input) => {
      if (input.length < 1 || input.length > this.maxInputCharacters) {
        throw new EmbeddingProviderError(
          `Embedding input must contain between 1 and ${this.maxInputCharacters} characters.`,
          'input_size_invalid',
        );
      }
      return deterministicVector(input, this.dimensions);
    });
  }
}

export const VERTEX_EMBEDDING_PROVIDER_KEY = 'vertex';
export const VERTEX_EMBEDDING_MODEL = 'gemini-embedding-001';
export const VERTEX_EMBEDDING_DEFAULT_DIMENSIONS = 768;
export const VERTEX_EMBEDDING_MAX_INPUT_CHARACTERS = 8_000;
export const VERTEX_EMBEDDING_MAX_BATCH_SIZE = 1;
const VERTEX_EMBEDDING_TIMEOUT_MS = 15_000;
const VERTEX_EMBEDDING_MAX_RETRIES = 2;
const VERTEX_EMBEDDING_BACKOFF_BASE_MS = 250;
const VERTEX_EMBEDDING_BACKOFF_MAX_MS = 2_000;

export type VertexEmbeddingRequest = Readonly<{
  config: Readonly<{
    abortSignal: AbortSignal;
    autoTruncate: false;
    httpOptions: Readonly<{ retryOptions: Readonly<{ attempts: 1 }> }>;
    outputDimensionality: number;
    taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';
  }>;
  contents: string;
  model: string;
}>;

export type VertexEmbeddingResponse = Readonly<{
  embeddings?: ReadonlyArray<Readonly<{ values?: ReadonlyArray<number> }>>;
}>;

export interface VertexEmbeddingClient {
  embedContent(request: VertexEmbeddingRequest): Promise<VertexEmbeddingResponse>;
}

export type VertexEmbeddingClientFactory = (
  configuration: Readonly<{ location: string; project: string; vertexai: true }>,
) => VertexEmbeddingClient;

export type VertexEmbeddingClock = Readonly<{
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

export type VertexEmbeddingProviderOptions = Readonly<{
  client?: VertexEmbeddingClient;
  clientFactory?: VertexEmbeddingClientFactory;
  clock?: VertexEmbeddingClock;
  dimensions: number;
  location: string;
  maxRetries?: number;
  model: string;
  modelVersion: string;
  project: string;
  timeoutMs?: number;
}>;

const defaultVertexEmbeddingClock: VertexEmbeddingClock = {
  sleep: (delayMs, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

const defaultVertexEmbeddingClientFactory: VertexEmbeddingClientFactory = (configuration) => {
  const sdk = new GoogleGenAI(configuration);
  return {
    embedContent: (request) =>
      sdk.models.embedContent(request) as Promise<VertexEmbeddingResponse>,
  };
};

function configuredPositiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!value || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EmbeddingProviderError(
      `${name} must be configured as a positive integer.`,
      'provider_configuration_invalid',
    );
  }
  return parsed;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = Number((error as { status?: unknown }).status);
  return Number.isSafeInteger(status) && status >= 0 && status <= 599 ? status : undefined;
}

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TypeError ||
    error.name === 'ConnectionError' ||
    error.name === 'RequestAbortedError' ||
    error.name === 'RequestTimeoutError'
  );
}

function isRetryableVertexEmbeddingError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

function normalizedVertexEmbeddingError(
  error: unknown,
  aborted: boolean,
  deadlineExpired: boolean,
): EmbeddingProviderError {
  if (error instanceof EmbeddingProviderError) return error;
  if (deadlineExpired) {
    return new EmbeddingProviderError(
      'The embedding provider request timed out.',
      'provider_timeout',
      true,
    );
  }
  if (aborted) {
    return new EmbeddingProviderError(
      'The embedding provider request was aborted.',
      'provider_aborted',
      true,
    );
  }
  if (isConnectionError(error)) {
    return new EmbeddingProviderError(
      'The embedding provider could not be reached.',
      'provider_connection_failed',
      true,
    );
  }
  const status = errorStatus(error);
  switch (status) {
    case 400:
    case 422:
      return new EmbeddingProviderError(
        'The embedding provider rejected the request.',
        'provider_request_invalid',
      );
    case 401:
      return new EmbeddingProviderError(
        'The embedding provider authentication failed.',
        'provider_authentication_failed',
      );
    case 403:
      return new EmbeddingProviderError(
        'The embedding provider denied the configured request.',
        'provider_permission_denied',
      );
    case 404:
      return new EmbeddingProviderError(
        'The configured embedding model is unavailable.',
        'provider_model_unavailable',
      );
    case 408:
    case 504:
      return new EmbeddingProviderError(
        'The embedding provider request timed out.',
        'provider_timeout',
        true,
      );
    case 409:
      return new EmbeddingProviderError(
        'The embedding provider reported a transient conflict.',
        'provider_conflict',
        true,
      );
    case 429:
      return new EmbeddingProviderError(
        'The embedding provider is rate limited.',
        'provider_rate_limited',
        true,
      );
    default:
      return new EmbeddingProviderError(
        'The embedding provider is unavailable.',
        status !== undefined && status >= 500 ? 'provider_unavailable' : 'provider_failed',
        status !== undefined && status >= 500,
      );
  }
}

function validateVertexVector(vector: readonly number[] | undefined, dimensions: number): number[] {
  if (
    !vector ||
    vector.length !== dimensions ||
    vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new EmbeddingProviderError(
      'The embedding provider returned an invalid vector.',
      'provider_output_invalid',
    );
  }
  return [...vector];
}

export class VertexEmbeddingProvider implements EmbeddingProvider {
  readonly providerKey = VERTEX_EMBEDDING_PROVIDER_KEY;
  readonly modelKey: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly maxInputCharacters = VERTEX_EMBEDDING_MAX_INPUT_CHARACTERS;
  readonly maxBatchSize = VERTEX_EMBEDDING_MAX_BATCH_SIZE;
  readonly #client: VertexEmbeddingClient;
  readonly #clock: VertexEmbeddingClock;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(options: VertexEmbeddingProviderOptions) {
    const project = options.project.trim();
    const location = options.location.trim();
    const model = options.model.trim();
    const modelVersion = options.modelVersion.trim();
    if (!project || !location || model !== VERTEX_EMBEDDING_MODEL || !modelVersion) {
      throw new EmbeddingProviderError(
        'Vertex embedding provider configuration is invalid.',
        'provider_configuration_invalid',
      );
    }
    if (
      !Number.isSafeInteger(options.timeoutMs ?? VERTEX_EMBEDDING_TIMEOUT_MS) ||
      (options.timeoutMs ?? VERTEX_EMBEDDING_TIMEOUT_MS) < 1 ||
      !Number.isSafeInteger(options.maxRetries ?? VERTEX_EMBEDDING_MAX_RETRIES) ||
      (options.maxRetries ?? VERTEX_EMBEDDING_MAX_RETRIES) < 0 ||
      (options.maxRetries ?? VERTEX_EMBEDDING_MAX_RETRIES) > 5
    ) {
      throw new EmbeddingProviderError(
        'Vertex embedding provider retry or timeout configuration is invalid.',
        'provider_configuration_invalid',
      );
    }
    this.modelKey = model;
    this.modelVersion = modelVersion;
    this.dimensions = options.dimensions;
    this.#clock = options.clock ?? defaultVertexEmbeddingClock;
    this.#maxRetries = options.maxRetries ?? VERTEX_EMBEDDING_MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? VERTEX_EMBEDDING_TIMEOUT_MS;
    validateDescriptor(this);
    this.#client =
      options.client ??
      (options.clientFactory ?? defaultVertexEmbeddingClientFactory)({
        location,
        project,
        vertexai: true,
      });
  }

  async embed(
    inputs: readonly string[],
    options: EmbeddingRequestOptions = {},
  ): Promise<readonly (readonly number[])[]> {
    if (inputs.length !== 1) {
      throw new EmbeddingProviderError(
        'gemini-embedding-001 accepts exactly one input per request.',
        'batch_size_invalid',
      );
    }
    const input = inputs[0] ?? '';
    if (input.trim().length < 1 || input.length > this.maxInputCharacters) {
      throw new EmbeddingProviderError(
        `Embedding input must contain between 1 and ${this.maxInputCharacters} characters.`,
        'input_size_invalid',
      );
    }
    if (options.task !== 'retrieval-document' && options.task !== 'retrieval-query') {
      throw new EmbeddingProviderError(
        'A retrieval embedding task must be selected explicitly.',
        'embedding_task_required',
      );
    }

    const controller = new AbortController();
    let deadlineExpired = false;
    const onCallerAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onCallerAbort();
    else options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timeout = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new Error('embedding-provider-deadline'));
    }, this.#timeoutMs);

    try {
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          const response = await this.#client.embedContent({
            config: {
              abortSignal: controller.signal,
              autoTruncate: false,
              httpOptions: { retryOptions: { attempts: 1 } },
              outputDimensionality: this.dimensions,
              taskType:
                options.task === 'retrieval-document'
                  ? 'RETRIEVAL_DOCUMENT'
                  : 'RETRIEVAL_QUERY',
            },
            contents: input,
            model: this.modelKey,
          });
          if (response.embeddings?.length !== 1) {
            throw new EmbeddingProviderError(
              'The embedding provider returned an invalid response.',
              'provider_output_invalid',
            );
          }
          return [validateVertexVector(response.embeddings[0]?.values, this.dimensions)];
        } catch (error) {
          if (
            !controller.signal.aborted &&
            isRetryableVertexEmbeddingError(error) &&
            attempt <= this.#maxRetries
          ) {
            const delayMs = Math.min(
              VERTEX_EMBEDDING_BACKOFF_MAX_MS,
              VERTEX_EMBEDDING_BACKOFF_BASE_MS * 2 ** (attempt - 1),
            );
            try {
              await this.#clock.sleep(delayMs, controller.signal);
            } catch (sleepError) {
              throw normalizedVertexEmbeddingError(
                sleepError,
                options.signal?.aborted === true,
                deadlineExpired,
              );
            }
            continue;
          }
          throw normalizedVertexEmbeddingError(
            error,
            options.signal?.aborted === true,
            deadlineExpired,
          );
        }
      }
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

export function createDefaultEmbeddingProviderRegistry(
  configuredProvider = process.env.EMBEDDING_PROVIDER,
  runtime = process.env.NODE_ENV ?? 'development',
  environment: NodeJS.ProcessEnv = process.env,
): EmbeddingProviderRegistry {
  const providerKey = configuredProvider?.trim().toLowerCase();
  if (!providerKey) {
    if (runtime === 'production') {
      throw new EmbeddingProviderError(
        'EMBEDDING_PROVIDER must be configured in production.',
        'provider_not_configured',
      );
    }
    const local = new DeterministicLocalEmbeddingProvider();
    return new EmbeddingProviderRegistry([local], local);
  }

  if (providerKey === 'local') {
    if (runtime === 'production') {
      throw new EmbeddingProviderError(
        'The deterministic local embedding provider is forbidden in production.',
        'provider_local_forbidden',
      );
    }
    const local = new DeterministicLocalEmbeddingProvider();
    return new EmbeddingProviderRegistry([local], local);
  }

  if (providerKey === VERTEX_EMBEDDING_PROVIDER_KEY) {
    const provider = new VertexEmbeddingProvider({
      dimensions: configuredPositiveInteger(environment.EMBEDDING_DIMENSIONS, 'EMBEDDING_DIMENSIONS'),
      location: environment.EMBEDDING_LOCATION ?? environment.GOOGLE_CLOUD_LOCATION ?? '',
      model: environment.EMBEDDING_MODEL ?? '',
      modelVersion: environment.EMBEDDING_MODEL_VERSION ?? '',
      project: environment.GOOGLE_CLOUD_PROJECT ?? '',
    });
    return new EmbeddingProviderRegistry([provider], provider);
  }

  throw new EmbeddingProviderError(
    `Embedding provider "${providerKey}" is not configured.`,
    'provider_not_configured',
  );
}