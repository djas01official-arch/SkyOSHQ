import type { BackgroundJobHandler, ExpiredLeaseRecoveryHook } from './runtime';
import {
  createDomainBackgroundJobHandler,
  recoverDomainJobAfterExpiredLease,
  type DomainBackgroundJobDependencies,
} from './domain-handlers';
import {
  createDurableAiOrchestrationHandler,
  DURABLE_AI_ORCHESTRATION_JOB_KIND,
  recoverDurableAiOrchestrationAfterExpiredLease,
} from '../ai/durable-ai-orchestration';
import type { AiConversationDependencies } from '../ai/ai-conversations';
import type { PrismaClient } from '../generated/client/client';

export type SkyOsBackgroundJobDependencies = Readonly<{
  ai: AiConversationDependencies;
  domain: DomainBackgroundJobDependencies;
}>;

export function createSkyOsBackgroundJobHandler(
  prisma: PrismaClient,
  dependencies: SkyOsBackgroundJobDependencies,
): BackgroundJobHandler {
  const domain = createDomainBackgroundJobHandler(prisma, dependencies.domain);
  const ai = createDurableAiOrchestrationHandler(prisma, dependencies.ai);
  return async (job) => {
    if (job.kind === DURABLE_AI_ORCHESTRATION_JOB_KIND) {
      await ai(job);
      return;
    }
    await domain(job);
  };
}

export const recoverSkyOsJobAfterExpiredLease: ExpiredLeaseRecoveryHook = async (
  transaction,
  job,
  terminal,
) => {
  if (job.kind === DURABLE_AI_ORCHESTRATION_JOB_KIND) {
    await recoverDurableAiOrchestrationAfterExpiredLease(transaction, job, terminal);
    return;
  }
  await recoverDomainJobAfterExpiredLease(transaction, job, terminal);
};
