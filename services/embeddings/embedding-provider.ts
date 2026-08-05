import { createHash } from 'node:crypto';

export type EmbeddingProviderDescriptor = Readonly<{
  providerKey: string;
  modelKey: string;
  modelVersion: string;
  dimensions: number;
  maxInputCharacters: number;
  maxBatchSize: number;
}>;

export interface EmbeddingProvider extends EmbeddingProviderDescriptor {
  embed(
    inputs: readonly string[],
    options?: Readonly<{ signal?: AbortSignal }>,
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

export function createDefaultEmbeddingProviderRegistry(
  configuredProvider = process.env.EMBEDDING_PROVIDER,
): EmbeddingProviderRegistry {
  const local = new DeterministicLocalEmbeddingProvider();
  const providerKey = configuredProvider?.trim().toLowerCase() || local.providerKey;
  if (providerKey !== local.providerKey) {
    throw new EmbeddingProviderError(
      `Embedding provider "${providerKey}" is not configured. Use "local" or install a validated provider adapter.`,
      'provider_not_configured',
    );
  }
  return new EmbeddingProviderRegistry([local], local);
}
