import {
  AiConversationStatus,
  AiMessageRole,
  AiOrchestrationMode,
  AiRoutingConfiguredMode,
  AiTaskAmbiguity,
  AiTaskAnalysisSignal,
  AiTaskComplexity,
  AiTaskExpectedEffort,
  AiTaskRisk,
  AiTaskRoutingReason,
  AiTaskVerificationNeed,
  type AiRoutingDecision,
  type PrismaClient,
} from '../generated/client/client';
import type { AiTaskAnalysis } from '../../services/ai/ai-task-analyzer';
import type { AiTaskRoutingDecision } from '../../services/ai/ai-mode-router';
import type { AiOrchestrationModeKey } from '../../services/ai/ai-orchestration-policy';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AiConfiguredRoutingMode = 'AUTO' | AiOrchestrationModeKey;

export type AiRoutingAuditAnalysis =
  | AiTaskAnalysis
  | Readonly<{
      routingInput: Readonly<{
        ambiguity: 'NOT_ANALYZED';
        complexity: 'NOT_ANALYZED';
        expectedEffort: 'NOT_ANALYZED';
        risk: 'NOT_ANALYZED';
        verificationNeed: 'NOT_ANALYZED';
      }>;
      signals: readonly ['EXPLICIT_MODE'];
    }>;

export type AiRoutingAuditDecision =
  AiTaskRoutingDecision | Readonly<{ mode: AiOrchestrationModeKey; reason: 'EXPLICIT_MODE' }>;

export type CreateAiRoutingDecisionInput = Readonly<{
  actorUserId: string;
  analysis: AiRoutingAuditAnalysis;
  configuredMode: AiConfiguredRoutingMode;
  conversationId: string;
  decision: AiRoutingAuditDecision;
  userMessageId: string;
  workspaceId: string;
}>;

export class AiRoutingDecisionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export class AiRoutingDecisionConflictError extends AiRoutingDecisionError {}
export class AiRoutingDecisionNotFoundError extends AiRoutingDecisionError {}
export class AiRoutingDecisionValidationError extends AiRoutingDecisionError {}
export class AiRoutingDecisionAuthorizationError extends AiRoutingDecisionError {}

export function explicitAiRoutingAudit(mode: AiOrchestrationModeKey): Readonly<{
  analysis: AiRoutingAuditAnalysis;
  decision: AiRoutingAuditDecision;
}> {
  return Object.freeze({
    analysis: Object.freeze({
      routingInput: Object.freeze({
        ambiguity: 'NOT_ANALYZED' as const,
        complexity: 'NOT_ANALYZED' as const,
        expectedEffort: 'NOT_ANALYZED' as const,
        risk: 'NOT_ANALYZED' as const,
        verificationNeed: 'NOT_ANALYZED' as const,
      }),
      signals: Object.freeze(['EXPLICIT_MODE'] as const),
    }),
    decision: Object.freeze({ mode, reason: 'EXPLICIT_MODE' as const }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function enumIncludes(values: Record<string, string>, value: unknown): value is string {
  return typeof value === 'string' && Object.values(values).includes(value);
}

function invalidInput(): never {
  throw new AiRoutingDecisionValidationError(
    'The AI routing decision input is invalid.',
    'routing_decision_invalid',
  );
}

function usesExplicitModeMetadata(input: CreateAiRoutingDecisionInput): boolean {
  const routingInput = input.analysis.routingInput;
  return (
    input.decision.reason === 'EXPLICIT_MODE' &&
    input.analysis.signals.length === 1 &&
    input.analysis.signals[0] === 'EXPLICIT_MODE' &&
    routingInput.ambiguity === 'NOT_ANALYZED' &&
    routingInput.complexity === 'NOT_ANALYZED' &&
    routingInput.expectedEffort === 'NOT_ANALYZED' &&
    routingInput.risk === 'NOT_ANALYZED' &&
    routingInput.verificationNeed === 'NOT_ANALYZED'
  );
}

function usesAutomaticModeMetadata(input: CreateAiRoutingDecisionInput): boolean {
  const routingInput = input.analysis.routingInput;
  const dimensionValues: readonly string[] = [
    routingInput.ambiguity,
    routingInput.complexity,
    routingInput.expectedEffort,
    routingInput.risk,
    routingInput.verificationNeed,
  ];
  const signals: readonly string[] = input.analysis.signals;
  return (
    input.decision.reason !== 'EXPLICIT_MODE' &&
    !signals.includes('EXPLICIT_MODE') &&
    !dimensionValues.includes('NOT_ANALYZED')
  );
}

function validateInput(input: CreateAiRoutingDecisionInput): void {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'actorUserId',
      'analysis',
      'configuredMode',
      'conversationId',
      'decision',
      'userMessageId',
      'workspaceId',
    ]) ||
    !UUID_PATTERN.test(input.actorUserId) ||
    !UUID_PATTERN.test(input.workspaceId) ||
    !UUID_PATTERN.test(input.conversationId) ||
    !UUID_PATTERN.test(input.userMessageId) ||
    !enumIncludes(AiRoutingConfiguredMode, input.configuredMode) ||
    !isRecord(input.analysis) ||
    !hasExactKeys(input.analysis, ['routingInput', 'signals']) ||
    !Array.isArray(input.analysis.signals) ||
    input.analysis.signals.some((signal) => !enumIncludes(AiTaskAnalysisSignal, signal)) ||
    new Set(input.analysis.signals).size !== input.analysis.signals.length ||
    !isRecord(input.analysis.routingInput) ||
    !hasExactKeys(input.analysis.routingInput, [
      'ambiguity',
      'complexity',
      'expectedEffort',
      'risk',
      'verificationNeed',
    ]) ||
    !enumIncludes(AiTaskAmbiguity, input.analysis.routingInput.ambiguity) ||
    !enumIncludes(AiTaskComplexity, input.analysis.routingInput.complexity) ||
    !enumIncludes(AiTaskExpectedEffort, input.analysis.routingInput.expectedEffort) ||
    !enumIncludes(AiTaskRisk, input.analysis.routingInput.risk) ||
    !enumIncludes(AiTaskVerificationNeed, input.analysis.routingInput.verificationNeed) ||
    !isRecord(input.decision) ||
    !hasExactKeys(input.decision, ['mode', 'reason']) ||
    !enumIncludes(AiOrchestrationMode, input.decision.mode) ||
    !enumIncludes(AiTaskRoutingReason, input.decision.reason) ||
    (input.configuredMode === 'AUTO'
      ? !usesAutomaticModeMetadata(input)
      : input.configuredMode !== input.decision.mode || !usesExplicitModeMetadata(input))
  ) {
    invalidInput();
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

async function requireAiRoutingDecisionAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  let access: Awaited<ReturnType<typeof requireKnowledgeWorkspaceAccess>>;
  try {
    access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
  } catch (error) {
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiRoutingDecisionAuthorizationError(
        'AI routing audit access requires effective permissions in the selected workspace.',
        'routing_decision_forbidden',
      );
    }
    throw error;
  }
  if (!workspaceRoleGrantsPermission(access.role, 'ai.use')) {
    throw new AiRoutingDecisionAuthorizationError(
      'AI routing audit access requires ai.use in the selected workspace.',
      'routing_decision_forbidden',
    );
  }
}

/**
 * Persists one already-computed deterministic routing result. This boundary does
 * not analyze the request, route it, or execute a language-model provider.
 */
export async function createAiRoutingDecision(
  prisma: PrismaClient,
  input: CreateAiRoutingDecisionInput,
): Promise<AiRoutingDecision> {
  validateInput(input);
  await requireAiRoutingDecisionAccess(prisma, input.actorUserId, input.workspaceId);

  const userMessage = await prisma.aiMessage.findFirst({
    where: {
      authorUserId: input.actorUserId,
      conversation: {
        ownerUserId: input.actorUserId,
        status: AiConversationStatus.ACTIVE,
      },
      conversationId: input.conversationId,
      id: input.userMessageId,
      role: AiMessageRole.USER,
      workspaceId: input.workspaceId,
    },
    select: { id: true },
  });
  if (!userMessage) {
    throw new AiRoutingDecisionNotFoundError(
      'The Chat user message was not found in this workspace and conversation.',
      'routing_message_not_found',
    );
  }

  const existing = await prisma.aiRoutingDecision.findUnique({
    where: { userMessageId: input.userMessageId },
    select: { id: true },
  });
  if (existing) {
    throw new AiRoutingDecisionConflictError(
      'A routing decision already exists for this user message.',
      'routing_decision_exists',
    );
  }

  try {
    return await prisma.aiRoutingDecision.create({
      data: {
        ambiguity: input.analysis.routingInput.ambiguity,
        complexity: input.analysis.routingInput.complexity,
        configuredMode: input.configuredMode,
        conversationId: input.conversationId,
        expectedEffort: input.analysis.routingInput.expectedEffort,
        reason: input.decision.reason,
        resolvedMode: input.decision.mode,
        risk: input.analysis.routingInput.risk,
        signals: [...input.analysis.signals],
        userMessageId: input.userMessageId,
        verificationNeed: input.analysis.routingInput.verificationNeed,
        workspaceId: input.workspaceId,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AiRoutingDecisionConflictError(
        'A routing decision already exists for this user message.',
        'routing_decision_exists',
      );
    }
    throw error;
  }
}

export async function getAiRoutingDecision(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  userMessageId: string,
): Promise<AiRoutingDecision> {
  if (
    !UUID_PATTERN.test(actorUserId) ||
    !UUID_PATTERN.test(workspaceId) ||
    !UUID_PATTERN.test(userMessageId)
  ) {
    invalidInput();
  }
  await requireAiRoutingDecisionAccess(prisma, actorUserId, workspaceId);

  const routingDecision = await prisma.aiRoutingDecision.findFirst({
    where: {
      userMessage: {
        authorUserId: actorUserId,
        conversation: { ownerUserId: actorUserId },
        role: AiMessageRole.USER,
      },
      userMessageId,
      workspaceId,
    },
  });
  if (!routingDecision) {
    throw new AiRoutingDecisionNotFoundError(
      'The AI routing decision was not found in this workspace.',
      'routing_decision_not_found',
    );
  }
  return routingDecision;
}
