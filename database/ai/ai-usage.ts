import { AiRunStatus, type PrismaClient } from '../generated/client/client';
import {
  KnowledgeAuthorizationError,
  requireKnowledgeWorkspaceAccess,
} from '../knowledge/knowledge-documents';
import { workspaceRoleGrantsPermission } from '../policy/authorization-policy';

export const AI_USAGE_RECENT_RUN_LIMIT = 25;
export const AI_USAGE_TIME_ZONE = 'UTC';

export class AiUsageAuthorizationError extends Error {}

export type AiUsagePeriodBoundaries = Readonly<{
  monthEnd: Date;
  monthStart: Date;
  todayEnd: Date;
  todayStart: Date;
}>;

export type AiUsageDashboard = Readonly<{
  boundaries: AiUsagePeriodBoundaries;
  recentRuns: readonly Readonly<{
    cacheWriteInputTokens: number | null;
    cachedInputTokens: number | null;
    createdAt: Date;
    estimatedCostUsd: string | null;
    id: string;
    inputTokens: number | null;
    modelKey: string;
    outputTokens: number | null;
    providerKey: string;
    requestingUser: Readonly<{ id: string; label: string }>;
    status: AiRunStatus;
    totalTokens: number | null;
  }>[];
  summary: Readonly<{
    cacheWriteInputTokensMonth: number;
    cachedInputTokensMonth: number;
    estimatedCostMonthUsd: string | null;
    estimatedCostTodayUsd: string | null;
    incompleteUsageRunsMonth: number;
    inputTokensMonth: number;
    outputTokensMonth: number;
    successfulRunsMonth: number;
    successfulRunsToday: number;
    totalTokensMonth: number;
    unknownCostRunsMonth: number;
    unknownCostRunsToday: number;
  }>;
  timeZone: typeof AI_USAGE_TIME_ZONE;
  workspaceId: string;
}>;

function validDate(value: Date): Date {
  if (Number.isNaN(value.valueOf())) {
    throw new Error('AI usage boundaries require a valid date.');
  }
  return value;
}

export function getUtcAiUsageBoundaries(now = new Date()): AiUsagePeriodBoundaries {
  const current = validDate(now);
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const day = current.getUTCDate();

  return {
    monthEnd: new Date(Date.UTC(year, month + 1, 1)),
    monthStart: new Date(Date.UTC(year, month, 1)),
    todayEnd: new Date(Date.UTC(year, month, day + 1)),
    todayStart: new Date(Date.UTC(year, month, day)),
  };
}

async function requireAiUsageAccess(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const access = await requireKnowledgeWorkspaceAccess(prisma, actorUserId, workspaceId, false);
    if (
      !workspaceRoleGrantsPermission(access.role, 'ai.use') ||
      !workspaceRoleGrantsPermission(access.role, 'workspace.members.read')
    ) {
      throw new AiUsageAuthorizationError(
        'AI usage access requires workspace administration permissions.',
      );
    }
  } catch (error) {
    if (error instanceof AiUsageAuthorizationError) throw error;
    if (error instanceof KnowledgeAuthorizationError) {
      throw new AiUsageAuthorizationError(
        'AI usage access requires workspace administration permissions.',
      );
    }
    throw error;
  }
}

function userLabel(user: {
  displayName: string | null;
  email: string | null;
  name: string | null;
}): string {
  return user.displayName ?? user.name ?? user.email ?? 'Unknown user';
}

export async function getAiUsageDashboard(
  prisma: PrismaClient,
  actorUserId: string,
  workspaceId: string,
  now = new Date(),
): Promise<AiUsageDashboard> {
  await requireAiUsageAccess(prisma, actorUserId, workspaceId);
  const boundaries = getUtcAiUsageBoundaries(now);
  const todayFilter = {
    createdAt: { gte: boundaries.todayStart, lt: boundaries.todayEnd },
    status: AiRunStatus.SUCCEEDED,
    workspaceId,
  } as const;
  const monthFilter = {
    createdAt: { gte: boundaries.monthStart, lt: boundaries.monthEnd },
    status: AiRunStatus.SUCCEEDED,
    workspaceId,
  } as const;

  const [
    todayUsage,
    todayCost,
    unknownCostRunsToday,
    monthUsage,
    monthCost,
    unknownCostRunsMonth,
    incompleteUsageRunsMonth,
    recentRuns,
  ] = await prisma.$transaction([
    prisma.aiRun.aggregate({ _count: { _all: true }, where: todayFilter }),
    prisma.aiRun.aggregate({
      _sum: { estimatedCostUsd: true },
      where: { ...todayFilter, estimatedCostUsd: { not: null } },
    }),
    prisma.aiRun.count({ where: { ...todayFilter, estimatedCostUsd: null } }),
    prisma.aiRun.aggregate({
      _count: { _all: true },
      _sum: {
        cacheWriteInputTokens: true,
        cachedInputTokens: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
      },
      where: monthFilter,
    }),
    prisma.aiRun.aggregate({
      _sum: { estimatedCostUsd: true },
      where: { ...monthFilter, estimatedCostUsd: { not: null } },
    }),
    prisma.aiRun.count({ where: { ...monthFilter, estimatedCostUsd: null } }),
    prisma.aiRun.count({
      where: {
        ...monthFilter,
        OR: [
          { cacheWriteInputTokens: null },
          { cachedInputTokens: null },
          { inputTokens: null },
          { outputTokens: null },
          { totalTokens: null },
        ],
      },
    }),
    prisma.aiRun.findMany({
      include: {
        requestedBy: {
          select: { displayName: true, email: true, id: true, name: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AI_USAGE_RECENT_RUN_LIMIT,
      where: { workspaceId },
    }),
  ]);

  return {
    boundaries,
    recentRuns: recentRuns.map((run) => ({
      cacheWriteInputTokens: run.cacheWriteInputTokens,
      cachedInputTokens: run.cachedInputTokens,
      createdAt: run.createdAt,
      estimatedCostUsd: run.estimatedCostUsd?.toString() ?? null,
      id: run.id,
      inputTokens: run.inputTokens,
      modelKey: run.modelKey,
      outputTokens: run.outputTokens,
      providerKey: run.providerKey,
      requestingUser: { id: run.requestedBy.id, label: userLabel(run.requestedBy) },
      status: run.status,
      totalTokens: run.totalTokens,
    })),
    summary: {
      cacheWriteInputTokensMonth: monthUsage._sum.cacheWriteInputTokens ?? 0,
      cachedInputTokensMonth: monthUsage._sum.cachedInputTokens ?? 0,
      estimatedCostMonthUsd: monthCost._sum.estimatedCostUsd?.toString() ?? null,
      estimatedCostTodayUsd: todayCost._sum.estimatedCostUsd?.toString() ?? null,
      incompleteUsageRunsMonth,
      inputTokensMonth: monthUsage._sum.inputTokens ?? 0,
      outputTokensMonth: monthUsage._sum.outputTokens ?? 0,
      successfulRunsMonth: monthUsage._count._all,
      successfulRunsToday: todayUsage._count._all,
      totalTokensMonth: monthUsage._sum.totalTokens ?? 0,
      unknownCostRunsMonth,
      unknownCostRunsToday,
    },
    timeZone: AI_USAGE_TIME_ZONE,
    workspaceId,
  };
}
