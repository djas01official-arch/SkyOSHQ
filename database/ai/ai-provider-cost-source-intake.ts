import type { PrismaClient } from '../generated/client/client';
import {
  canIngestProviderCostSourceAsAuthoritativeRunEvidence,
  findProviderCostEvidenceCapability,
  type ProviderCostEvidenceCapability,
  type ProviderCostEvidenceProviderKey,
} from './ai-provider-cost-capabilities';
import {
  ingestAiCostEvidenceRecord,
  type AiCostEvidenceSourceAdapter,
  type IngestAiCostEvidenceRecordResult,
} from './ai-cost-evidence-ingestion';

export type ProviderCostSourceAuthorization =
  | Readonly<{
      capability: ProviderCostEvidenceCapability;
      status: 'AUTHORIZED';
    }>
  | Readonly<{
      capability: ProviderCostEvidenceCapability | null;
      reasonCode:
        'UNKNOWN_SOURCE' | 'PROVIDER_MISMATCH' | ProviderCostEvidenceCapability['reasonCode'];
      status: 'BLOCKED';
    }>;

export type ProviderCostSourceIntakeInput = Readonly<{
  adapter: AiCostEvidenceSourceAdapter;
  expectedProviderKey?: string;
  rawRecord: unknown;
  sourceId: string;
}>;

export type ProviderCostSourceIntakeResult =
  | Readonly<{
      authorization: Extract<ProviderCostSourceAuthorization, { status: 'BLOCKED' }>;
      status: 'BLOCKED_SOURCE';
    }>
  | Readonly<{
      authorization: Extract<ProviderCostSourceAuthorization, { status: 'AUTHORIZED' }>;
      ingestion: IngestAiCostEvidenceRecordResult;
      status: 'AUTHORIZED_REQUEST_EVIDENCE';
    }>;

type ProviderCostSourceIntakeDependencies = Readonly<{
  findCapability: (sourceId: string) => ProviderCostEvidenceCapability | undefined;
  ingestTrustedRecord: (
    prisma: PrismaClient,
    adapter: AiCostEvidenceSourceAdapter,
    rawRecord: unknown,
  ) => Promise<IngestAiCostEvidenceRecordResult>;
}>;

const PRODUCTION_DEPENDENCIES: ProviderCostSourceIntakeDependencies = Object.freeze({
  findCapability: findProviderCostEvidenceCapability,
  ingestTrustedRecord: ingestAiCostEvidenceRecord,
});

export function authorizeProviderCostEvidenceSource(
  input: Readonly<{
    expectedProviderKey?: string;
    sourceId: string;
  }>,
): ProviderCostSourceAuthorization {
  return authorizeProviderCostEvidenceSourceWithDependencies(input, PRODUCTION_DEPENDENCIES);
}

function authorizeProviderCostEvidenceSourceWithDependencies(
  input: Readonly<{ expectedProviderKey?: string; sourceId: string }>,
  dependencies: Pick<ProviderCostSourceIntakeDependencies, 'findCapability'>,
): ProviderCostSourceAuthorization {
  const capability = dependencies.findCapability(input.sourceId);
  if (!capability) {
    return Object.freeze({
      capability: null,
      reasonCode: 'UNKNOWN_SOURCE',
      status: 'BLOCKED' as const,
    });
  }
  if (
    input.expectedProviderKey !== undefined &&
    input.expectedProviderKey !== capability.providerKey
  ) {
    return Object.freeze({
      capability,
      reasonCode: 'PROVIDER_MISMATCH',
      status: 'BLOCKED' as const,
    });
  }
  if (!canIngestProviderCostSourceAsAuthoritativeRunEvidence(capability)) {
    return Object.freeze({
      capability,
      reasonCode: capability.reasonCode,
      status: 'BLOCKED' as const,
    });
  }
  return Object.freeze({ capability, status: 'AUTHORIZED' as const });
}

async function ingestProviderSourceCostEvidenceWithDependencies(
  prisma: PrismaClient,
  input: ProviderCostSourceIntakeInput,
  dependencies: ProviderCostSourceIntakeDependencies,
): Promise<ProviderCostSourceIntakeResult> {
  const authorization = authorizeProviderCostEvidenceSourceWithDependencies(input, dependencies);
  if (authorization.status === 'BLOCKED') {
    return Object.freeze({ authorization, status: 'BLOCKED_SOURCE' as const });
  }

  if (
    input.adapter.providerKey !== authorization.capability.providerKey ||
    !isProviderKey(authorization.capability.providerKey)
  ) {
    return Object.freeze({
      authorization: Object.freeze({
        capability: authorization.capability,
        reasonCode: 'PROVIDER_MISMATCH' as const,
        status: 'BLOCKED' as const,
      }),
      status: 'BLOCKED_SOURCE' as const,
    });
  }

  const ingestion = await dependencies.ingestTrustedRecord(prisma, input.adapter, input.rawRecord);
  return Object.freeze({
    authorization,
    ingestion,
    status: 'AUTHORIZED_REQUEST_EVIDENCE' as const,
  });
}

function isProviderKey(value: string): value is ProviderCostEvidenceProviderKey {
  return value === 'openai' || value === 'anthropic' || value === 'gemini';
}

/**
 * Internal production boundary for future provider-originated records. Built-in
 * aggregate sources stop here before normalization, mapping, or persistence.
 */
export async function ingestProviderSourceCostEvidence(
  prisma: PrismaClient,
  input: ProviderCostSourceIntakeInput,
): Promise<ProviderCostSourceIntakeResult> {
  return ingestProviderSourceCostEvidenceWithDependencies(prisma, input, PRODUCTION_DEPENDENCIES);
}

/**
 * Test composition only. It proves a future independently verified source can
 * reuse the trusted ingestion path without making the production registry mutable.
 */
export function createTestProviderCostSourceIntake(
  dependencies: ProviderCostSourceIntakeDependencies,
): (
  prisma: PrismaClient,
  input: ProviderCostSourceIntakeInput,
) => Promise<ProviderCostSourceIntakeResult> {
  return (prisma, input) =>
    ingestProviderSourceCostEvidenceWithDependencies(prisma, input, dependencies);
}
