from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# 1. Durable server boundary: request identity -> message -> route -> context -> job.
path = Path("database/ai/durable-ai-chat.ts")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import {\n  AiConversationStatus,",
    "import { randomUUID } from 'node:crypto';\n\nimport {\n  AiConversationStatus,",
    "node crypto import",
)
text = replace_once(
    text,
    "  type AiRun,\n  type PrismaClient,",
    "  type AiRoutingDecision,\n  type AiRun,\n  type PrismaClient,",
    "routing decision type import",
)
text = replace_once(
    text,
    "const MAX_REQUESTS_PER_MINUTE = 10;",
    "const MAX_REQUESTS_PER_MINUTE = 10;\nconst UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;",
    "uuid pattern",
)
text = replace_once(
    text,
    "  mode?: string;\n}>;",
    "  mode?: string;\n  requestId?: string;\n}>;",
    "runtime request id",
)

start = text.index("async function persistLongModeMessage(")
end = text.index("\nfunction resolveAssignment(", start)
helper_and_persist = r'''function durableRequestId(value: string | undefined): string {
  if (value === undefined) return randomUUID();
  const normalized = value.trim();
  if (!UUID_PATTERN.test(normalized)) {
    throw new AiConversationValidationError(
      'The AI request identity is invalid.',
      'chat_request_id_invalid',
    );
  }
  return normalized;
}

function routingDecisionMatches(
  decision: AiRoutingDecision,
  resolved: ReturnType<typeof routing>,
  conversationId: string,
  userMessageId: string,
  workspaceId: string,
): boolean {
  const input = resolved.analysis.routingInput;
  return (
    decision.workspaceId === workspaceId &&
    decision.conversationId === conversationId &&
    decision.userMessageId === userMessageId &&
    decision.configuredMode === resolved.configuredMode &&
    decision.resolvedMode === resolved.resolvedMode &&
    decision.reason === resolved.decision.reason &&
    decision.signals.length === resolved.analysis.signals.length &&
    decision.signals.every((signal, index) => signal === resolved.analysis.signals[index]) &&
    decision.complexity === input.complexity &&
    decision.risk === input.risk &&
    decision.ambiguity === input.ambiguity &&
    decision.verificationNeed === input.verificationNeed &&
    decision.expectedEffort === input.expectedEffort
  );
}

async function getOrCreateRoutingDecision(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  userMessageId: string,
  resolved: ReturnType<typeof routing>,
): Promise<AiRoutingDecision> {
  const existing = await prisma.aiRoutingDecision.findUnique({ where: { userMessageId } });
  if (existing) {
    if (!routingDecisionMatches(existing, resolved, conversationId, userMessageId, workspaceId)) {
      throw new AiConversationError(
        'The AI request identity is already bound to a different routing decision.',
        'routing_audit_conflict',
      );
    }
    return existing;
  }
  try {
    return await createAiRoutingDecision(prisma, {
      actorUserId,
      analysis: resolved.analysis,
      configuredMode: resolved.configuredMode,
      conversationId,
      decision: resolved.decision,
      userMessageId,
      workspaceId,
    });
  } catch {
    const raced = await prisma.aiRoutingDecision.findUnique({ where: { userMessageId } });
    if (raced) {
      if (!routingDecisionMatches(raced, resolved, conversationId, userMessageId, workspaceId)) {
        throw new AiConversationError(
          'The AI request identity is already bound to a different routing decision.',
          'routing_audit_conflict',
        );
      }
      return raced;
    }
    throw new AiConversationError(
      'The AI request could not be recorded for execution.',
      'routing_audit_failed',
    );
  }
}

async function persistLongModeMessage(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  conversationId: string,
  message: string,
  requestId: string,
) {
  await requireAiAccess(prisma, actorUserId, workspaceId);
  const conversation = await prisma.aiConversation.findFirst({
    where: {
      id: conversationId,
      ownerUserId: actorUserId,
      status: AiConversationStatus.ACTIVE,
      workspaceId,
    },
  });
  if (!conversation) {
    throw new AiConversationNotFoundError(
      'The AI conversation was not found in this workspace.',
      'conversation_not_found',
    );
  }
  const acceptedAt = new Date();
  return prisma.$transaction(async (transaction) => {
    const lockKey = `ai-chat-submit:${requestId}`;
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    const existing = await transaction.aiMessage.findUnique({ where: { id: requestId } });
    if (existing) {
      if (
        existing.authorUserId !== actorUserId ||
        existing.workspaceId !== workspaceId ||
        existing.conversationId !== conversationId ||
        existing.role !== AiMessageRole.USER ||
        existing.content !== message
      ) {
        throw new AiConversationError(
          'The AI request identity is already bound to different immutable input.',
          'chat_submission_conflict',
        );
      }
      return existing;
    }
    const recent = await transaction.aiMessage.count({
      where: {
        authorUserId: actorUserId,
        createdAt: { gte: new Date(Date.now() - 60_000) },
        role: AiMessageRole.USER,
        workspaceId,
      },
    });
    if (recent >= MAX_REQUESTS_PER_MINUTE) {
      throw new AiConversationRateLimitError(
        'Too many AI requests. Try again in a minute.',
        'rate_limited',
      );
    }
    const created = await transaction.aiMessage.create({
      data: {
        authorUserId: actorUserId,
        content: message,
        conversationId,
        id: requestId,
        role: AiMessageRole.USER,
        workspaceId,
      },
    });
    await transaction.aiConversation.update({
      where: { id: conversation.id },
      data: {
        title:
          conversation.title === 'New conversation'
            ? message.replace(/\s+/gu, ' ').slice(0, 80)
            : conversation.title,
        updatedAt: acceptedAt,
      },
    });
    return created;
  });
}
'''
text = text[:start] + helper_and_persist + text[end:]

submit_marker = "export async function submitDurableAiChatMessage("
submit_index = text.index(submit_marker)
helpers = r'''async function existingQueuedSubmission(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  routingDecisionId: string,
) {
  return prisma.backgroundJob.findFirst({
    where: {
      idempotencyKey: `ai-orchestration:${routingDecisionId}`,
      requestedByUserId: actorUserId,
      workspaceId,
    },
    select: { domainJobId: true, id: true },
  });
}

async function prepareOrReuseGroundedContext(
  prisma: PrismaClient,
  dependencies: AiConversationDependencies,
  actorUserId: string,
  workspaceId: string,
  message: string,
  routingDecisionId: string,
) {
  const existing = await prisma.aiRetrievalSnapshot.findFirst({
    where: { createdByUserId: actorUserId, routingDecisionId, workspaceId },
    select: { id: true },
  });
  if (existing) return Object.freeze({ groundedContextId: existing.id });
  try {
    return await prepareOrchestratedChatRequest(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      message,
      routingDecisionId,
    );
  } catch (error) {
    const raced = await prisma.aiRetrievalSnapshot.findFirst({
      where: { createdByUserId: actorUserId, routingDecisionId, workspaceId },
      select: { id: true },
    });
    if (raced) return Object.freeze({ groundedContextId: raced.id });
    throw error;
  }
}

'''
text = text[:submit_index] + helpers + text[submit_index:]

text = replace_once(
    text,
    "  const persisted = await persistLongModeMessage(\n    prisma,\n    actorUserId,\n    workspaceId,\n    conversationId,\n    message,\n  );",
    "  const requestId = durableRequestId(runtime.requestId);\n  const persisted = await persistLongModeMessage(\n    prisma,\n    actorUserId,\n    workspaceId,\n    conversationId,\n    message,\n    requestId,\n  );",
    "persist request identity",
)
old_route = r'''  let routingDecision;
  try {
    routingDecision = await createAiRoutingDecision(prisma, {
      actorUserId,
      analysis: resolved.analysis,
      configuredMode: resolved.configuredMode,
      conversationId,
      decision: resolved.decision,
      userMessageId: persisted.id,
      workspaceId,
    });
  } catch {
    throw new AiConversationError(
      'The AI request could not be recorded for execution.',
      'routing_audit_failed',
    );
  }

  const mode = resolved.resolvedMode;
  const assignment = resolveAssignment(dependencies, mode, runtime);'''
new_route = r'''  const routingDecision = await getOrCreateRoutingDecision(
    prisma,
    actorUserId,
    workspaceId,
    conversationId,
    persisted.id,
    resolved,
  );

  const mode = resolved.resolvedMode;
  const existingJob = await existingQueuedSubmission(
    prisma,
    actorUserId,
    workspaceId,
    routingDecision.id,
  );
  if (existingJob) {
    return Object.freeze({
      jobId: existingJob.id,
      mode,
      orchestrationId: existingJob.domainJobId,
      queued: true as const,
    });
  }
  const assignment = resolveAssignment(dependencies, mode, runtime);'''
text = replace_once(text, old_route, new_route, "routing decision reuse")
text = replace_once(
    text,
    r'''    prepared = await prepareOrchestratedChatRequest(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      message,
      routingDecision.id,
    );''',
    r'''    prepared = await prepareOrReuseGroundedContext(
      prisma,
      dependencies,
      actorUserId,
      workspaceId,
      message,
      routingDecision.id,
    );''',
    "grounded context reuse",
)
text = replace_once(
    text,
    r'''    const existing = await prisma.backgroundJob.findUnique({
      where: { idempotencyKey: `ai-orchestration:${routingDecision.id}` },
      select: { domainJobId: true, id: true },
    });''',
    r'''    const existing = await existingQueuedSubmission(
      prisma,
      actorUserId,
      workspaceId,
      routingDecision.id,
    );''',
    "queue race reuse",
)
path.write_text(text, encoding="utf-8")


# 2. Server action forwards a stable browser request identity when present.
path = Path("apps/web/app/ai/actions.ts")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "  try {\n    await submitDurableAiChatMessage(\n      prisma,\n      aiConversationDependencies,\n      user.id,\n      context.activeWorkspace.id,\n      conversationId,\n      value(formData, 'message'),\n    );",
    "  try {\n    const requestId = value(formData, 'requestId');\n    await submitDurableAiChatMessage(\n      prisma,\n      aiConversationDependencies,\n      user.id,\n      context.activeWorkspace.id,\n      conversationId,\n      value(formData, 'message'),\n      requestId ? { requestId } : {},\n    );",
    "server action request id",
)
path.write_text(text, encoding="utf-8")


# 3. Browser keeps one UUID for an unchanged draft and rotates it whenever the draft changes.
path = Path("apps/web/components/ai/ai-message-composer.tsx")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import { useActionState } from 'react';",
    "import { useActionState, useState } from 'react';",
    "composer state import",
)
text = replace_once(
    text,
    "  const [state, formAction, pending] = useActionState(submitMessageAction, initialState);",
    "  const [state, formAction, pending] = useActionState(submitMessageAction, initialState);\n  const [requestId, setRequestId] = useState('');",
    "composer request state",
)
text = replace_once(
    text,
    '      <input name="conversationId" type="hidden" value={conversationId} />',
    '      <input name="conversationId" type="hidden" value={conversationId} />\n      <input name="requestId" type="hidden" value={requestId} />',
    "composer hidden request id",
)
text = replace_once(
    text,
    '        name="message"\n        placeholder="Ask about workspace Knowledge"',
    '        name="message"\n        onChange={() => setRequestId(crypto.randomUUID())}\n        placeholder="Ask about workspace Knowledge"',
    "composer request rotation",
)
path.write_text(text, encoding="utf-8")


# 4. Fix route-bound test fixture and add ingress duplicate/conflict proof.
path = Path("database/tests/durable-ai-orchestration.integration.test.ts")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "import { createAiConversation, type AiConversationDependencies } from '../ai/ai-conversations';",
    "import {\n  AiConversationError,\n  createAiConversation,\n  type AiConversationDependencies,\n} from '../ai/ai-conversations';\nimport { submitDurableAiChatMessage } from '../ai/durable-ai-chat';",
    "durable test imports",
)
text = replace_once(
    text,
    "  const context = createGroundedContext(workspace.id, retrieval, {\n    knowledgeDocumentVersionId: version.id,\n    type: AiGroundedContextSourceType.KNOWLEDGE_DOCUMENT_VERSION,\n  });",
    "  const context = createGroundedContext(workspace.id, retrieval, {\n    type: AiGroundedContextSourceType.WORKSPACE_RETRIEVAL,\n  });",
    "route-bound fixture source",
)
appended = r'''

test('duplicate long-mode web submissions reuse one immutable request and durable job', async () => {
  const f = await fixture();
  let geminiCalls = 0;
  let openAiCalls = 0;
  let anthropicCalls = 0;
  const registry = new LanguageModelProviderRegistry(
    model('gemini', 'gemini-model', 'gemini-v1', 'gemini answer', () => {
      geminiCalls += 1;
    }),
  );
  registry.register(
    model('openai', 'openai-model', 'openai-v1', 'openai answer', () => {
      openAiCalls += 1;
    }),
  );
  registry.register(
    model('anthropic', 'anthropic-model', 'anthropic-v1', 'anthropic answer', () => {
      anthropicCalls += 1;
    }),
  );
  const dependencies: AiConversationDependencies = {
    providers: registry,
    retrieval: retrievalDependencies,
  };
  const assignment: BalancedAiProviderAssignment = {
    candidates: [
      { modelKey: 'gemini-model', modelVersion: 'gemini-v1', providerKey: 'gemini' },
      { modelKey: 'openai-model', modelVersion: 'openai-v1', providerKey: 'openai' },
    ],
    synthesizer: {
      modelKey: 'anthropic-model',
      modelVersion: 'anthropic-v1',
      providerKey: 'anthropic',
    },
  };
  const requestId = randomUUID();
  const runtime = {
    balancedProviderConfiguration: {
      candidateA: assignment.candidates[0],
      candidateB: assignment.candidates[1],
      synthesizer: assignment.synthesizer,
    },
    budgetEnvironment: { AI_BUDGET_ENFORCEMENT: 'DISABLED' },
    mode: 'BALANCED',
    requestId,
  } as const;
  const message = 'Queue this retry-safe BALANCED request.';

  const first = await submitDurableAiChatMessage(
    prisma,
    dependencies,
    f.user.id,
    f.workspace.id,
    f.conversation.id,
    message,
    runtime,
  );
  const duplicate = await submitDurableAiChatMessage(
    prisma,
    dependencies,
    f.user.id,
    f.workspace.id,
    f.conversation.id,
    message,
    runtime,
  );
  if (first.mode === 'FAST' || duplicate.mode === 'FAST') {
    assert.fail('BALANCED submissions must remain durable.');
  }

  assert.equal(duplicate.jobId, first.jobId);
  assert.equal(duplicate.orchestrationId, first.orchestrationId);
  assert.equal(geminiCalls + openAiCalls + anthropicCalls, 0);
  const persistedMessage = await prisma.aiMessage.findUniqueOrThrow({ where: { id: requestId } });
  assert.equal(persistedMessage.content, message);
  assert.equal(persistedMessage.role, AiMessageRole.USER);
  const decision = await prisma.aiRoutingDecision.findUniqueOrThrow({
    where: { userMessageId: requestId },
  });
  assert.equal(decision.configuredMode, 'BALANCED');
  assert.equal(decision.resolvedMode, 'BALANCED');
  assert.equal(
    await prisma.aiRetrievalSnapshot.count({ where: { routingDecisionId: decision.id } }),
    1,
  );
  assert.equal(
    await prisma.backgroundJob.count({
      where: { idempotencyKey: `ai-orchestration:${decision.id}` },
    }),
    1,
  );
  assert.equal(
    await prisma.aiOrchestration.count({
      where: { id: first.orchestrationId, userMessageId: requestId },
    }),
    1,
  );

  await assert.rejects(
    () =>
      submitDurableAiChatMessage(
        prisma,
        dependencies,
        f.user.id,
        f.workspace.id,
        f.conversation.id,
        'Different immutable content for the same request identity.',
        runtime,
      ),
    (error: unknown) =>
      error instanceof AiConversationError && error.code === 'chat_submission_conflict',
  );
  assert.equal(await prisma.aiMessage.count({ where: { id: requestId } }), 1);
});
'''
if "duplicate long-mode web submissions reuse one immutable request and durable job" not in text:
    text = text.rstrip() + appended
path.write_text(text.rstrip() + "\n", encoding="utf-8")


# 5. Align ADR with the actual ingress identity contract.
path = Path("architecture/decisions/0010-durable-ai-orchestration.md")
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "The durable job idempotency key is derived from the immutable routing decision. Enqueue is serialized with a PostgreSQL advisory transaction lock, and `BackgroundJob.idempotencyKey` remains the database uniqueness barrier. A duplicate web request or retry therefore reuses the same durable job instead of silently creating a second orchestration.",
    "The browser assigns each unchanged long-mode draft a client request UUID. SkyOS serializes that identity with a PostgreSQL advisory transaction lock and persists it as the immutable user-message identity; reusing the UUID with different content fails closed. The deterministic routing decision is then reused for that same message, a route-bound GroundedContext is created at most once, and the durable job idempotency key is derived from the immutable routing decision. `BackgroundJob.idempotencyKey` remains the final database uniqueness barrier. A duplicate web request, lost-response retry, or duplicate queue submission therefore converges on the same message, route, GroundedContext, orchestration, and durable job instead of silently creating another execution.",
    "ADR ingress idempotency",
)
path.write_text(text, encoding="utf-8")
