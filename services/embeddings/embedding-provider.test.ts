import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DeterministicLocalEmbeddingProvider,
  EmbeddingProviderError,
  EmbeddingProviderRegistry,
  VertexEmbeddingProvider,
  VERTEX_EMBEDDING_MODEL,
  createDefaultEmbeddingProviderRegistry,
  type VertexEmbeddingClient,
  type VertexEmbeddingRequest,
} from './embedding-provider';

const MODEL_VERSION = 'retrieval-v1';

function finiteVector(dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_value, index) => (index + 1) / dimensions);
}

function isProviderErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function vertexProvider(
  client: VertexEmbeddingClient,
  overrides: Partial<ConstructorParameters<typeof VertexEmbeddingProvider>[0]> = {},
): VertexEmbeddingProvider {
  return new VertexEmbeddingProvider({
    client,
    clock: { sleep: async () => undefined },
    dimensions: 3,
    location: 'europe-west1',
    maxRetries: 0,
    model: VERTEX_EMBEDDING_MODEL,
    modelVersion: MODEL_VERSION,
    project: 'skyos-test-project',
    timeoutMs: 5_000,
    ...overrides,
  });
}

async function expectProviderError(
  operation: Promise<unknown>,
  code: string,
): Promise<EmbeddingProviderError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof EmbeddingProviderError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected ${code}.`);
}

class FakeVertexError extends Error {
  readonly status: number;

  constructor(status: number, message = 'unsafe upstream detail') {
    super(message);
    this.status = status;
  }
}

test('local embeddings remain deterministic and isolated for tests/development', async () => {
  const provider = new DeterministicLocalEmbeddingProvider();
  const first = await provider.embed(['The aircraft is in the northern hangar.']);
  const second = await provider.embed(['The aircraft is in the northern hangar.']);

  assert.deepEqual(first, second);
  assert.equal(first[0]?.length, 64);
  assert.ok(first[0]?.every(Number.isFinite));
});

test('production fails closed when embedding provider is absent or local', () => {
  assert.throws(
    () => createDefaultEmbeddingProviderRegistry('', 'production', {}),
    (error: unknown) => isProviderErrorWithCode(error, 'provider_not_configured'),
  );
  assert.throws(
    () => createDefaultEmbeddingProviderRegistry('local', 'production', {}),
    (error: unknown) => isProviderErrorWithCode(error, 'provider_local_forbidden'),
  );
});

test('explicit Vertex environment resolves a versioned 768-dimensional contract', () => {
  const registry = createDefaultEmbeddingProviderRegistry('vertex', 'production', {
    EMBEDDING_DIMENSIONS: '768',
    EMBEDDING_LOCATION: 'europe-west1',
    EMBEDDING_MODEL: VERTEX_EMBEDDING_MODEL,
    EMBEDDING_MODEL_VERSION: MODEL_VERSION,
    GOOGLE_CLOUD_PROJECT: 'skyos-test-project',
  });
  const provider = registry.getCurrent();

  assert.equal(provider.providerKey, 'vertex');
  assert.equal(provider.modelKey, VERTEX_EMBEDDING_MODEL);
  assert.equal(provider.modelVersion, MODEL_VERSION);
  assert.equal(provider.dimensions, 768);
  assert.equal(provider.maxBatchSize, 1);
});

test('Vertex provider sends only chunk text with document retrieval configuration', async () => {
  const requests: VertexEmbeddingRequest[] = [];
  const provider = vertexProvider({
    embedContent: async (request) => {
      requests.push(request);
      return { embeddings: [{ values: finiteVector(3) }] };
    },
  });

  const vectors = await provider.embed(['Harmless knowledge text.'], {
    task: 'retrieval-document',
  });

  assert.equal(vectors[0]?.length, 3);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.contents, 'Harmless knowledge text.');
  assert.equal(requests[0]?.model, VERTEX_EMBEDDING_MODEL);
  assert.equal(requests[0]?.config.taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(requests[0]?.config.outputDimensionality, 3);
  assert.equal(requests[0]?.config.autoTruncate, false);
  assert.equal(requests[0]?.config.httpOptions.retryOptions.attempts, 1);
});

test('Vertex provider uses query retrieval configuration for query vectors', async () => {
  const requests: VertexEmbeddingRequest[] = [];
  const provider = vertexProvider({
    embedContent: async (request) => {
      requests.push(request);
      return { embeddings: [{ values: finiteVector(3) }] };
    },
  });

  await provider.embed(['Where is the plane kept?'], { task: 'retrieval-query' });

  assert.equal(requests[0]?.config.taskType, 'RETRIEVAL_QUERY');
});

test('Vertex provider rejects empty input, unsupported batches, and missing task', async () => {
  const provider = vertexProvider({
    embedContent: async () => ({ embeddings: [{ values: finiteVector(3) }] }),
  });

  await expectProviderError(provider.embed([], { task: 'retrieval-document' }), 'batch_size_invalid');
  await expectProviderError(provider.embed(['   '], { task: 'retrieval-document' }), 'input_size_invalid');
  await expectProviderError(provider.embed(['one', 'two'], { task: 'retrieval-document' }), 'batch_size_invalid');
  await expectProviderError(provider.embed(['one']), 'embedding_task_required');
});

test('Vertex provider rejects malformed and dimensionally incompatible responses', async () => {
  const malformed = vertexProvider({ embedContent: async () => ({ embeddings: [] }) });
  await expectProviderError(
    malformed.embed(['knowledge'], { task: 'retrieval-document' }),
    'provider_output_invalid',
  );

  const wrongDimension = vertexProvider({
    embedContent: async () => ({ embeddings: [{ values: finiteVector(2) }] }),
  });
  await expectProviderError(
    wrongDimension.embed(['knowledge'], { task: 'retrieval-document' }),
    'provider_output_invalid',
  );
});

test('Vertex provider retries bounded transient failures without SDK retries', async () => {
  let calls = 0;
  const delays: number[] = [];
  const provider = vertexProvider(
    {
      embedContent: async () => {
        calls += 1;
        if (calls < 3) throw new FakeVertexError(503);
        return { embeddings: [{ values: finiteVector(3) }] };
      },
    },
    {
      clock: {
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
      maxRetries: 2,
    },
  );

  const result = await provider.embed(['knowledge'], { task: 'retrieval-document' });

  assert.equal(result.length, 1);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test('Vertex provider returns safe nonretryable permission errors and never falls back to local', async () => {
  let calls = 0;
  const provider = vertexProvider({
    embedContent: async () => {
      calls += 1;
      throw new FakeVertexError(403, 'credential material must never surface');
    },
  });
  const registry = new EmbeddingProviderRegistry([provider], provider);

  const error = await expectProviderError(
    provider.embed(['knowledge'], { task: 'retrieval-document' }),
    'provider_permission_denied',
  );
  assert.equal(calls, 1);
  assert.equal(error.retryable, false);
  assert.doesNotMatch(error.message, /credential material/u);
  assert.throws(
    () => registry.getVersion('local', 'deterministic-feature-hash', '1.0.0'),
    (registryError: unknown) =>
      isProviderErrorWithCode(registryError, 'provider_version_unavailable'),
  );
});

test('Vertex provider rejects invalid model and dimension configuration', () => {
  const client: VertexEmbeddingClient = {
    embedContent: async () => ({ embeddings: [{ values: finiteVector(3) }] }),
  };
  assert.throws(
    () => vertexProvider(client, { model: 'unexpected-model' }),
    (error: unknown) => isProviderErrorWithCode(error, 'provider_configuration_invalid'),
  );
  assert.throws(
    () => vertexProvider(client, { dimensions: 2_001 }),
    (error: unknown) => isProviderErrorWithCode(error, 'provider_configuration_invalid'),
  );
});