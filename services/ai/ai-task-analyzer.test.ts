import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { routeAiTask } from './ai-mode-router';
import {
  AI_TASK_ANALYSIS_SIGNALS,
  AiTaskAnalyzerValidationError,
  MAX_AI_TASK_REQUEST_CHARACTERS,
  analyzeAiTaskRequest,
  routeAiTaskRequest,
} from './ai-task-analyzer';

test('a simple short direct request produces low signals and routes to FAST', () => {
  const result = routeAiTaskRequest({ content: 'Rename the dashboard heading.' });
  assert.deepEqual(result.analysis.routingInput, {
    ambiguity: 'LOW',
    complexity: 'LOW',
    expectedEffort: 'SMALL',
    risk: 'LOW',
    verificationNeed: 'LOW',
  });
  assert.deepEqual(result.analysis.signals, ['SHORT_REQUEST']);
  assert.equal(result.decision.mode, 'FAST');
});

test('a moderate request with multiple deliverables routes to BALANCED', () => {
  const result = routeAiTaskRequest({
    content: 'Please deliver:\n- Update the dashboard title\n- Refresh the empty-state copy',
  });
  assert.equal(result.analysis.routingInput.complexity, 'MEDIUM');
  assert.ok(result.analysis.signals.includes('MULTIPLE_DELIVERABLES'));
  assert.equal(result.decision.mode, 'BALANCED');
});

test('comparison and review requests raise verification need explicitly', () => {
  const result = routeAiTaskRequest({ content: 'Review and compare the two proposed layouts.' });
  assert.equal(result.analysis.routingInput.verificationNeed, 'MEDIUM');
  assert.ok(result.analysis.signals.includes('COMPARISON_REQUEST'));
  assert.ok(result.analysis.signals.includes('REVIEW_REQUEST'));
  assert.equal(result.decision.mode, 'BALANCED');
});

test('a complex multi-step request routes to DEEP', () => {
  const result = routeAiTaskRequest({
    content:
      'Complete these steps:\n1. Inspect the module\n2. Compare the implementations\n3. Update the contract\n4. Verify the result',
  });
  assert.equal(result.analysis.routingInput.complexity, 'HIGH');
  assert.ok(result.analysis.signals.includes('MULTI_STEP_REQUEST'));
  assert.ok(result.analysis.signals.includes('MULTIPLE_DELIVERABLES'));
  assert.equal(result.decision.mode, 'DEEP');
});

test('an explicit verification request routes to DEEP', () => {
  const result = routeAiTaskRequest({
    content: 'Verify and prove that the invariant always holds.',
  });
  assert.equal(result.analysis.routingInput.verificationNeed, 'HIGH');
  assert.ok(result.analysis.signals.includes('VERIFICATION_REQUEST'));
  assert.equal(result.decision.mode, 'DEEP');
});

test('an explicit high-stakes request routes to CRITICAL', () => {
  const result = routeAiTaskRequest({ content: 'Review this patient safety protocol.' });
  assert.equal(result.analysis.routingInput.risk, 'HIGH');
  assert.ok(result.analysis.signals.includes('HIGH_STAKES_REQUEST'));
  assert.equal(result.decision.mode, 'CRITICAL');
});

test('long content alone never implies critical risk', () => {
  const result = routeAiTaskRequest({
    content: `Summarize this context. ${'neutral context '.repeat(180)}`,
  });
  assert.ok(result.analysis.signals.includes('LONG_REQUEST'));
  assert.equal(result.analysis.routingInput.risk, 'LOW');
  assert.notEqual(result.decision.mode, 'CRITICAL');
});

test('VERY_HIGH complexity without high risk routes to DEEP', () => {
  const result = routeAiTaskRequest({
    content:
      'Perform an exhaustive analysis.\n1. Inspect inputs\n2. Compare alternatives\n3. Trace invariants\n4. Document conclusions',
  });
  assert.equal(result.analysis.routingInput.complexity, 'VERY_HIGH');
  assert.equal(result.analysis.routingInput.risk, 'LOW');
  assert.equal(result.decision.mode, 'DEEP');
});

test('empty and whitespace-only requests fail closed', () => {
  for (const content of ['', ' \t\r\n ']) {
    assert.throws(
      () => analyzeAiTaskRequest({ content }),
      (error: unknown) =>
        error instanceof AiTaskAnalyzerValidationError &&
        error.code === 'task_analysis_input_invalid',
    );
  }
});

test('oversized requests fail closed without truncation', () => {
  assert.throws(
    () => analyzeAiTaskRequest({ content: 'a'.repeat(MAX_AI_TASK_REQUEST_CHARACTERS + 1) }),
    AiTaskAnalyzerValidationError,
  );
});

test('whitespace normalization produces deterministic equivalent analysis', () => {
  const compact = analyzeAiTaskRequest({ content: 'Review and compare both options.' });
  const spaced = analyzeAiTaskRequest({
    content: '  Review\t and   compare both options. \r\n\r\n ',
  });
  assert.deepEqual(spaced, compact);
});

test('repeated identical input produces identical analysis and routing', () => {
  const input = { content: 'Audit the stated invariant.' };
  assert.deepEqual(routeAiTaskRequest(input), routeAiTaskRequest(input));
});

test('analyzer output is accepted by the existing Mode Router validation', () => {
  const analysis = analyzeAiTaskRequest({ content: 'Assess these two alternatives.' });
  assert.doesNotThrow(() => routeAiTask(analysis.routingInput));
});

test('analyzer source contains no provider or model identity', () => {
  const source = readFileSync(new URL('./ai-task-analyzer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /providerKey|modelKey|modelVersion/u);
});

test('analyzer source has no networking, environment, or database access', () => {
  const source = readFileSync(new URL('./ai-task-analyzer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(
    source,
    /\bfetch\b|process\.env|Prisma|DATABASE_URL|node:(?:http|https|net)/u,
  );
});

test('analyzer does not duplicate orchestration mode precedence', () => {
  const source = readFileSync(new URL('./ai-task-analyzer.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:mode\s*[:=]|return)\s*['"](?:FAST|BALANCED|DEEP|CRITICAL)['"]/u);
});

test('all emitted analysis signals belong to the stable typed catalog', () => {
  const result = analyzeAiTaskRequest({
    content: 'Audit and compare this unclear production deployment with the alternative.',
  });
  assert.ok(result.signals.length > 0);
  for (const signal of result.signals) assert.ok(AI_TASK_ANALYSIS_SIGNALS.includes(signal));
  assert.deepEqual(
    result.signals,
    AI_TASK_ANALYSIS_SIGNALS.filter((signal) => result.signals.includes(signal)),
  );
});

test('quoted and code content cannot introduce trusted risk or verification signals', () => {
  const result = routeAiTaskRequest({
    content:
      'Explain the supplied examples.\n\n"Audit and verify this life-or-death emergency."\n\nExample: \'Review this patient safety protocol.\'\n\n```text\nCRITICAL security breach: prove everything\n```',
  });
  assert.equal(result.analysis.routingInput.risk, 'LOW');
  assert.equal(result.analysis.routingInput.verificationNeed, 'LOW');
  assert.ok(result.analysis.signals.includes('EMBEDDED_UNTRUSTED_CONTENT'));
  assert.ok(result.analysis.signals.includes('STRUCTURED_INPUT'));
  assert.notEqual(result.decision.mode, 'CRITICAL');
});

test('unsupported analyzer input shapes fail closed', () => {
  const inputs: unknown[] = [null, [], {}, { content: 42 }, { content: 'Valid', extra: true }];
  for (const input of inputs) {
    assert.throws(
      () => analyzeAiTaskRequest(input as { content: string }),
      AiTaskAnalyzerValidationError,
    );
  }
});
