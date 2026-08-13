import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  GROUNDED_ANSWER_CORPUS_VERSION,
  groundedAnswerEvaluationCorpus,
} from '../services/ai/evaluation/grounded-answer-corpus';
import {
  calculateConservativeEvaluationCost,
  createOpenAiLiveEvaluationProvider,
  LiveEvaluationConfigurationError,
  OPENAI_EVALUATION_PRICING,
  runGroundedAnswerEvaluation,
  serializeSanitizedEvaluationReport,
  validateOpenAiLiveEvaluationEnvironment,
} from '../services/ai/evaluation/grounded-answer-evaluator';

function dollars(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `$${value.toFixed(4)}`;
}

function safePreview(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function main(): Promise<void> {
  const configuration = validateOpenAiLiveEvaluationEnvironment(process.env);
  const provider = createOpenAiLiveEvaluationProvider(process.env);
  const maximumPlanningCost = calculateConservativeEvaluationCost(
    groundedAnswerEvaluationCorpus.length,
    provider.maxInputCharacters,
  );

  console.log('LIVE OpenAI staging evaluation explicitly enabled.');
  console.log(
    `Model ${provider.modelKey}; ${groundedAnswerEvaluationCorpus.length} sequential synthetic cases; no database access.`,
  );
  console.log(
    `Pricing snapshot verified ${OPENAI_EVALUATION_PRICING.verifiedOn}: $${OPENAI_EVALUATION_PRICING.inputUsdPerMillionTokens}/1M input, $${OPENAI_EVALUATION_PRICING.cacheWriteInputUsdPerMillionTokens}/1M cache-write input, $${OPENAI_EVALUATION_PRICING.cachedInputUsdPerMillionTokens}/1M cached input, and $${OPENAI_EVALUATION_PRICING.outputUsdPerMillionTokens}/1M output tokens.`,
  );
  console.log(
    `Conservative planning ceiling including all three possible adapter attempts: ${dollars(maximumPlanningCost)}. Actual cost depends on provider usage and retry outcomes.`,
  );

  const report = await runGroundedAnswerEvaluation(
    provider,
    GROUNDED_ANSWER_CORPUS_VERSION,
    groundedAnswerEvaluationCorpus,
    { redactedValues: [configuration.apiKey] },
  );

  for (const item of report.cases) {
    console.log(
      [
        item.hardPassed ? 'PASS' : 'FAIL',
        item.id,
        item.category,
        `${item.latencyMs}ms`,
        `${item.attemptCount ?? 0} attempt(s)`,
        `request=${item.providerRequestId ?? 'unavailable'}`,
        `tokens=${item.totalTokens ?? 'unavailable'}`,
        `citations=${item.candidateCitationIds.join(',') || 'none'}`,
        `preview=${safePreview(item.answerPreview) || 'unavailable'}`,
      ].join(' | '),
    );
  }

  const timestamp = report.executedAt.replaceAll(/[:.]/gu, '-');
  const reportDirectory = path.resolve('artifacts', 'ai-eval');
  const reportPath = path.join(reportDirectory, `openai-grounded-eval-${timestamp}.json`);
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, serializeSanitizedEvaluationReport(report, [configuration.apiKey]), {
    encoding: 'utf8',
    flag: 'wx',
  });

  console.log(
    `Latency staging observation: min=${report.latency.minMs}ms median=${report.latency.medianMs}ms p95=${report.latency.p95Ms}ms max=${report.latency.maxMs}ms.`,
  );
  console.log(
    `Usage: input=${report.usage.inputTokens}, cache-write=${report.usage.cacheWriteInputTokens}, cached=${report.usage.cachedInputTokens}, output=${report.usage.outputTokens}, total=${report.usage.totalTokens}, approximate cost=${dollars(report.usage.approximateCostUsd)}.`,
  );
  console.log(`Sanitized local report: ${reportPath}`);
  console.log(
    report.gate.hardInvariantsPassed
      ? 'Hard invariants passed. Human groundedness/usefulness review is still required before broader staging.'
      : 'The staging quality gate failed. Do not enable broader staging.',
  );
  if (!report.gate.hardInvariantsPassed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  console.error(
    error instanceof LiveEvaluationConfigurationError
      ? error.message
      : 'The OpenAI staging evaluation failed safely.',
  );
});
