/**
 * Verified capabilities of known provider-issued usage and billing sources.
 * This registry is deliberately descriptive: it neither fetches source data nor
 * authorizes ingestion. A source is usable for authoritative run evidence only
 * when it carries both an exact monetary amount and an exact execution join.
 */
export const PROVIDER_COST_EVIDENCE_SOURCE_IDS = [
  'OPENAI_ORGANIZATION_USAGE',
  'OPENAI_ORGANIZATION_COSTS',
  'ANTHROPIC_ADMIN_USAGE_REPORT',
  'GOOGLE_CLOUD_BILLING_STANDARD',
  'GOOGLE_CLOUD_BILLING_DETAILED',
] as const;

export type ProviderCostEvidenceSourceId = (typeof PROVIDER_COST_EVIDENCE_SOURCE_IDS)[number];
export type ProviderCostEvidenceProviderKey = 'openai' | 'anthropic' | 'gemini';
export type ProviderCostEvidenceFinancialGranularity = 'REQUEST' | 'AGGREGATED' | 'UNSUPPORTED';
export type ProviderCostEvidenceMonetaryCostCapability =
  'EXACT_MONETARY_COST' | 'NO_EXACT_MONETARY_COST' | 'UNSUPPORTED';
export type ProviderCostEvidenceRunMappingCapability =
  'EXACT_PROVIDER_REFERENCE' | 'NO_VERIFIED_REQUEST_JOIN' | 'UNSUPPORTED';
export type ProviderCostEvidenceCapabilityReasonCode =
  | 'VERIFIED_EXACT_REQUEST_EVIDENCE'
  | 'AGGREGATED_NOT_REQUEST_LEVEL'
  | 'NO_VERIFIED_REQUEST_REFERENCE'
  | 'NO_EXACT_MONETARY_COST'
  | 'UNSUPPORTED_SOURCE';

export type ProviderCostEvidenceCapability = Readonly<{
  authoritativeForAiRun: boolean;
  financialGranularity: ProviderCostEvidenceFinancialGranularity;
  monetaryCostCapability: ProviderCostEvidenceMonetaryCostCapability;
  providerKey: ProviderCostEvidenceProviderKey;
  reasonCode: ProviderCostEvidenceCapabilityReasonCode;
  runMappingCapability: ProviderCostEvidenceRunMappingCapability;
  sourceId: ProviderCostEvidenceSourceId | string;
}>;

function nonAuthoritativeCapability(
  sourceId: ProviderCostEvidenceSourceId,
  providerKey: ProviderCostEvidenceProviderKey,
  monetaryCostCapability: ProviderCostEvidenceMonetaryCostCapability,
): ProviderCostEvidenceCapability {
  return Object.freeze({
    authoritativeForAiRun: false,
    financialGranularity: 'AGGREGATED',
    monetaryCostCapability,
    providerKey,
    reasonCode: 'AGGREGATED_NOT_REQUEST_LEVEL',
    runMappingCapability: 'NO_VERIFIED_REQUEST_JOIN',
    sourceId,
  });
}

/**
 * Current live provider contracts are bucketed or aggregate data. They may be
 * useful for reconciliation, but none is an authoritative per-AiRun source.
 */
export const BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES = Object.freeze([
  nonAuthoritativeCapability('OPENAI_ORGANIZATION_USAGE', 'openai', 'NO_EXACT_MONETARY_COST'),
  nonAuthoritativeCapability('OPENAI_ORGANIZATION_COSTS', 'openai', 'EXACT_MONETARY_COST'),
  nonAuthoritativeCapability('ANTHROPIC_ADMIN_USAGE_REPORT', 'anthropic', 'NO_EXACT_MONETARY_COST'),
  nonAuthoritativeCapability('GOOGLE_CLOUD_BILLING_STANDARD', 'gemini', 'EXACT_MONETARY_COST'),
  nonAuthoritativeCapability('GOOGLE_CLOUD_BILLING_DETAILED', 'gemini', 'EXACT_MONETARY_COST'),
] as const);

export function getProviderCostEvidenceCapability(
  sourceId: ProviderCostEvidenceSourceId,
): ProviderCostEvidenceCapability {
  const capability = findProviderCostEvidenceCapability(sourceId);
  if (!capability) {
    throw new Error(`Unknown provider cost evidence source: ${sourceId}`);
  }
  return capability;
}

export function findProviderCostEvidenceCapability(
  sourceId: string,
): ProviderCostEvidenceCapability | undefined {
  return BUILT_IN_PROVIDER_COST_EVIDENCE_CAPABILITIES.find(
    (candidate) => candidate.sourceId === sourceId,
  );
}

/**
 * Authoritative evidence requires a source-issued exact monetary amount and a
 * verified exact join to a durable provider execution identity. Aggregate data
 * and SkyOS-only request IDs are intentionally insufficient.
 */
export function canIngestProviderCostSourceAsAuthoritativeRunEvidence(
  capability: ProviderCostEvidenceCapability,
): boolean {
  return (
    capability.authoritativeForAiRun &&
    capability.financialGranularity === 'REQUEST' &&
    capability.monetaryCostCapability === 'EXACT_MONETARY_COST' &&
    capability.runMappingCapability === 'EXACT_PROVIDER_REFERENCE'
  );
}
