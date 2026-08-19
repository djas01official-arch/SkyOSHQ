import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES,
  type ProviderCostEvidenceCapability,
} from '../ai/ai-provider-cost-capabilities';
import {
  authorizeProviderCostEvidenceSource,
  createTestProviderCostSourceIntake,
  ingestProviderSourceCostEvidence,
  type ProviderCostSourceIntakeInput,
} from '../ai/ai-provider-cost-source-intake';
import { openAiCostEvidenceSourceAdapter } from '../ai/ai-cost-evidence-ingestion';

const noDatabase = {} as never;

function futureCapability(): ProviderCostEvidenceCapability {
  return Object.freeze({
    authoritativeForAiRun: true,
    financialGranularity: 'REQUEST',
    monetaryCostCapability: 'EXACT_MONETARY_COST',
    providerKey: 'openai',
    reasonCode: 'VERIFIED_EXACT_REQUEST_EVIDENCE',
    runMappingCapability: 'EXACT_PROVIDER_REFERENCE',
    sourceId: 'TEST_FUTURE_OPENAI_REQUEST_COST',
  });
}

test('all registered OpenAI, Anthropic, and Google aggregate sources are blocked before adapter normalization', async () => {
  for (const capability of BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES) {
    let normalized = false;
    const adapter = {
      ...openAiCostEvidenceSourceAdapter,
      providerKey: capability.providerKey,
      normalize: () => {
        normalized = true;
        throw new Error('blocked sources must not normalize');
      },
    };
    const result = await ingestProviderSourceCostEvidence(noDatabase, {
      adapter,
      rawRecord: { ignored: true },
      sourceId: capability.sourceId,
    });
    assert.equal(result.status, 'BLOCKED_SOURCE');
    assert.equal(result.authorization.reasonCode, 'AGGREGATED_NOT_REQUEST_LEVEL');
    assert.equal(normalized, false);
  }
});

test('unknown sources and provider mismatches fail closed from registry facts', async () => {
  assert.deepEqual(authorizeProviderCostEvidenceSource({ sourceId: 'UNKNOWN_PROVIDER_SOURCE' }), {
    capability: null,
    reasonCode: 'UNKNOWN_SOURCE',
    status: 'BLOCKED',
  });
  const mismatch = await ingestProviderSourceCostEvidence(noDatabase, {
    adapter: openAiCostEvidenceSourceAdapter,
    expectedProviderKey: 'anthropic',
    rawRecord: {},
    sourceId: 'OPENAI_ORGANIZATION_COSTS',
  });
  assert.equal(mismatch.status, 'BLOCKED_SOURCE');
  assert.equal(mismatch.authorization.reasonCode, 'PROVIDER_MISMATCH');
});

test('caller-supplied authority-shaped fields cannot override the frozen production registry', async () => {
  const callerInput = {
    adapter: openAiCostEvidenceSourceAdapter,
    authoritativeForAiRun: true,
    financialGranularity: 'REQUEST',
    monetaryCostCapability: 'EXACT_MONETARY_COST',
    rawRecord: {},
    reasonCode: 'VERIFIED_EXACT_REQUEST_EVIDENCE',
    runMappingCapability: 'EXACT_PROVIDER_REFERENCE',
    sourceId: 'OPENAI_ORGANIZATION_COSTS',
  } as unknown as ProviderCostSourceIntakeInput;
  const result = await ingestProviderSourceCostEvidence(noDatabase, callerInput);
  assert.equal(result.status, 'BLOCKED_SOURCE');
  assert.equal(result.authorization.reasonCode, 'AGGREGATED_NOT_REQUEST_LEVEL');
  assert.equal(Object.isFrozen(BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES), true);
  assert.equal(Object.isFrozen(BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES[0]), true);
});

test('a test-only verified future source reaches the unchanged trusted ingestion boundary', async () => {
  const capability = futureCapability();
  let received: unknown;
  const intake = createTestProviderCostSourceIntake({
    findCapability: (sourceId) => (sourceId === capability.sourceId ? capability : undefined),
    ingestTrustedRecord: async (_prisma, adapter, rawRecord) => {
      received = { adapter, rawRecord };
      return { reason: 'provider_request_id_unmapped', status: 'UNMAPPED' };
    },
  });
  const rawRecord = { cost: { kind: 'USD_DECIMAL', value: '1.000000000000' } };
  const result = await intake(noDatabase, {
    adapter: openAiCostEvidenceSourceAdapter,
    expectedProviderKey: 'openai',
    rawRecord,
    sourceId: capability.sourceId,
  });

  assert.equal(result.status, 'AUTHORIZED_REQUEST_EVIDENCE');
  assert.deepEqual(received, { adapter: openAiCostEvidenceSourceAdapter, rawRecord });
  if (result.status === 'AUTHORIZED_REQUEST_EVIDENCE') {
    assert.deepEqual(result.ingestion, {
      reason: 'provider_request_id_unmapped',
      status: 'UNMAPPED',
    });
  }
});

test('an authorized source cannot establish execution identity or bypass existing mapping and normalization results', async () => {
  const capability = futureCapability();
  const results = [
    { reason: 'cost_invalid', status: 'INVALID' as const },
    { reason: 'source_reference_invalid', status: 'INVALID' as const },
    { reason: 'provider_request_id_unmapped', status: 'UNMAPPED' as const },
    { reason: 'provider_request_id_ambiguous', status: 'AMBIGUOUS' as const },
    { reason: 'ai_run_cost_evidence_conflict', status: 'CONFLICT' as const },
  ];
  for (const ingestion of results) {
    const intake = createTestProviderCostSourceIntake({
      findCapability: (sourceId) => (sourceId === capability.sourceId ? capability : undefined),
      ingestTrustedRecord: async () => ingestion,
    });
    const result = await intake(noDatabase, {
      adapter: openAiCostEvidenceSourceAdapter,
      rawRecord: {},
      sourceId: capability.sourceId,
    });
    assert.equal(result.status, 'AUTHORIZED_REQUEST_EVIDENCE');
    if (result.status === 'AUTHORIZED_REQUEST_EVIDENCE')
      assert.deepEqual(result.ingestion, ingestion);
  }
});
