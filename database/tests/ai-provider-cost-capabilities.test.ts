import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES,
  canIngestProviderCostSourceAsAuthoritativeRunEvidence,
  getProviderCostEvidenceCapability,
  type ProviderCostEvidenceCapability,
} from '../ai/ai-provider-cost-capabilities';

function futureCapability(
  overrides: Partial<ProviderCostEvidenceCapability> = {},
): ProviderCostEvidenceCapability {
  return {
    authoritativeForAiRun: true,
    financialGranularity: 'REQUEST',
    monetaryCostCapability: 'EXACT_MONETARY_COST',
    providerKey: 'openai',
    reasonCode: 'VERIFIED_EXACT_REQUEST_EVIDENCE',
    runMappingCapability: 'EXACT_PROVIDER_REFERENCE',
    sourceId: 'FUTURE_PROVIDER_REQUEST_COST_RECORD',
    ...overrides,
  };
}

test('all currently verified provider usage and billing sources fail the authoritative run-evidence gate', () => {
  assert.equal(BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES.length, 5);
  for (const capability of BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES) {
    assert.equal(capability.authoritativeForAiRun, false);
    assert.equal(capability.financialGranularity, 'AGGREGATED');
    assert.equal(capability.runMappingCapability, 'NO_VERIFIED_REQUEST_JOIN');
    assert.equal(canIngestProviderCostSourceAsAuthoritativeRunEvidence(capability), false);
  }
});

test('classifies OpenAI Organization Usage and Costs as aggregate, not request-level evidence', () => {
  const usage = getProviderCostEvidenceCapability('OPENAI_ORGANIZATION_USAGE');
  const costs = getProviderCostEvidenceCapability('OPENAI_ORGANIZATION_COSTS');

  assert.equal(usage.providerKey, 'openai');
  assert.equal(usage.monetaryCostCapability, 'NO_EXACT_MONETARY_COST');
  assert.equal(costs.providerKey, 'openai');
  assert.equal(costs.monetaryCostCapability, 'EXACT_MONETARY_COST');
  assert.equal(costs.reasonCode, 'AGGREGATED_NOT_REQUEST_LEVEL');
});

test('classifies Anthropic usage and both Google Cloud billing exports as aggregate, not request-level evidence', () => {
  const anthropic = getProviderCostEvidenceCapability('ANTHROPIC_ADMIN_USAGE_REPORT');
  const googleStandard = getProviderCostEvidenceCapability('GOOGLE_CLOUD_BILLING_STANDARD');
  const googleDetailed = getProviderCostEvidenceCapability('GOOGLE_CLOUD_BILLING_DETAILED');

  assert.equal(anthropic.providerKey, 'anthropic');
  assert.equal(anthropic.monetaryCostCapability, 'NO_EXACT_MONETARY_COST');
  assert.equal(googleStandard.providerKey, 'gemini');
  assert.equal(googleDetailed.providerKey, 'gemini');
});

test('aggregate costs, SkyOS-only request IDs, and exact costs without a verified provider join fail closed', () => {
  assert.equal(
    canIngestProviderCostSourceAsAuthoritativeRunEvidence(
      futureCapability({ financialGranularity: 'AGGREGATED' }),
    ),
    false,
  );
  assert.equal(
    canIngestProviderCostSourceAsAuthoritativeRunEvidence(
      futureCapability({ runMappingCapability: 'NO_VERIFIED_REQUEST_JOIN' }),
    ),
    false,
  );
  assert.equal(
    canIngestProviderCostSourceAsAuthoritativeRunEvidence(
      futureCapability({ monetaryCostCapability: 'NO_EXACT_MONETARY_COST' }),
    ),
    false,
  );
});

test('a future source is enabled only by exact per-request cost and exact provider execution reference', () => {
  assert.equal(canIngestProviderCostSourceAsAuthoritativeRunEvidence(futureCapability()), true);
  assert.equal(
    canIngestProviderCostSourceAsAuthoritativeRunEvidence(
      futureCapability({ authoritativeForAiRun: false }),
    ),
    false,
  );
});

test('the pure capability contract has no allocation, repricing, or persistence input', () => {
  const capability = futureCapability() as ProviderCostEvidenceCapability & Record<string, unknown>;
  for (const field of [
    'amount',
    'inputTokens',
    'modelKey',
    'projectId',
    'requestCount',
    'timestamp',
    'workspaceId',
  ]) {
    assert.equal(field in capability, false);
  }
});
