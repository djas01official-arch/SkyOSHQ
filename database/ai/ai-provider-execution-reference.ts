import { AiProviderExecutionReferenceType, type PrismaClient } from '../generated/client/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CANONICAL_PROVIDER_KEYS = ['openai', 'anthropic', 'gemini'] as const;
const PROVIDER_REFERENCE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const INPUT_KEYS = ['referenceType', 'referenceValue', 'runId'] as const;

type AiProviderExecutionReferenceClient = Pick<
  PrismaClient,
  'aiRun' | 'aiRunProviderExecutionReference'
>;

export type RecordAiRunProviderExecutionReferenceInput = Readonly<{
  referenceType: AiProviderExecutionReferenceType;
  referenceValue: string;
  runId: string;
}>;

export class AiRunProviderExecutionReferenceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiRunProviderExecutionReferenceConflictError extends AiRunProviderExecutionReferenceError {}
export class AiRunProviderExecutionReferenceNotFoundError extends AiRunProviderExecutionReferenceError {}
export class AiRunProviderExecutionReferenceValidationError extends AiRunProviderExecutionReferenceError {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalProviderKey(value: string): value is (typeof CANONICAL_PROVIDER_KEYS)[number] {
  return (CANONICAL_PROVIDER_KEYS as readonly string[]).includes(value);
}

function validInput(input: RecordAiRunProviderExecutionReferenceInput): boolean {
  if (!isRecord(input)) return false;
  const keys = Object.keys(input);
  return (
    keys.length === INPUT_KEYS.length &&
    keys.every((key) => INPUT_KEYS.includes(key as (typeof INPUT_KEYS)[number])) &&
    typeof input.runId === 'string' &&
    UUID_PATTERN.test(input.runId) &&
    input.referenceType === AiProviderExecutionReferenceType.REQUEST_ID &&
    typeof input.referenceValue === 'string' &&
    PROVIDER_REFERENCE_PATTERN.test(input.referenceValue)
  );
}

function sameReference(
  reference: Readonly<{ runId: string; workspaceId: string }>,
  run: Readonly<{ id: string; workspaceId: string }>,
): boolean {
  return reference.runId === run.id && reference.workspaceId === run.workspaceId;
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

async function findReference(
  prisma: AiProviderExecutionReferenceClient,
  input: RecordAiRunProviderExecutionReferenceInput,
  providerKey: string,
) {
  return prisma.aiRunProviderExecutionReference.findFirst({
    where: {
      providerKey,
      referenceType: input.referenceType,
      referenceValue: input.referenceValue,
    },
  });
}

/**
 * Records one authoritative provider execution identity from a known AiRun.
 * This internal primitive derives provider and workspace lineage from the run;
 * cost ingestion reads these records but can never create them.
 */
export async function recordAiRunProviderExecutionReference(
  prisma: AiProviderExecutionReferenceClient,
  input: RecordAiRunProviderExecutionReferenceInput,
) {
  if (!validInput(input)) {
    throw new AiRunProviderExecutionReferenceValidationError(
      'The AI run provider execution reference input is invalid.',
      'ai_run_provider_execution_reference_invalid',
    );
  }

  const run = await prisma.aiRun.findUnique({
    where: { id: input.runId },
    select: { id: true, providerKey: true, providerRequestId: true, workspaceId: true },
  });
  if (!run) {
    throw new AiRunProviderExecutionReferenceNotFoundError(
      'The AI run for the provider execution reference was not found.',
      'ai_run_provider_execution_reference_run_not_found',
    );
  }
  if (!isCanonicalProviderKey(run.providerKey) || run.providerRequestId !== input.referenceValue) {
    throw new AiRunProviderExecutionReferenceConflictError(
      'The provider execution reference does not match the target run.',
      'ai_run_provider_execution_reference_run_mismatch',
    );
  }

  const existing = await findReference(prisma, input, run.providerKey);
  if (existing) {
    if (sameReference(existing, run)) return existing;
    throw new AiRunProviderExecutionReferenceConflictError(
      'The provider execution reference is already assigned to another run.',
      'ai_run_provider_execution_reference_conflict',
    );
  }

  try {
    return await prisma.aiRunProviderExecutionReference.create({
      data: {
        providerKey: run.providerKey,
        referenceType: input.referenceType,
        referenceValue: input.referenceValue,
        runId: run.id,
        workspaceId: run.workspaceId,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await findReference(prisma, input, run.providerKey);
    if (concurrent && sameReference(concurrent, run)) return concurrent;
    throw new AiRunProviderExecutionReferenceConflictError(
      'The provider execution reference is already assigned to another run.',
      'ai_run_provider_execution_reference_conflict',
    );
  }
}
