import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AI_TASK_ROUTING_REASONS,
  AiModeRouterValidationError,
  routeAiTask,
  type AiTaskRoutingInput,
} from './ai-mode-router';

const trivialInput: AiTaskRoutingInput = {
  ambiguity: 'LOW',
  complexity: 'LOW',
  expectedEffort: 'SMALL',
  risk: 'LOW',
  verificationNeed: 'LOW',
};

test('trivial low-risk work routes to FAST with a stable reason', () => {
  assert.deepEqual(routeAiTask(trivialInput), {
    mode: 'FAST',
    reason: 'LOW_COMPLEXITY',
  });
});

test('moderate complexity routes to BALANCED', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, complexity: 'MEDIUM' }), {
    mode: 'BALANCED',
    reason: 'MODERATE_COMPLEXITY',
  });
});

test('moderate ambiguity elevates otherwise FAST work to BALANCED', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, ambiguity: 'MEDIUM' }), {
    mode: 'BALANCED',
    reason: 'MODERATE_AMBIGUITY',
  });
});

test('high complexity routes to DEEP', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, complexity: 'HIGH' }), {
    mode: 'DEEP',
    reason: 'HIGH_COMPLEXITY',
  });
});

test('high verification need routes to DEEP', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, verificationNeed: 'HIGH' }), {
    mode: 'DEEP',
    reason: 'HIGH_VERIFICATION_NEED',
  });
});

test('very-high complexity without high risk routes to DEEP, not CRITICAL', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, complexity: 'VERY_HIGH' }), {
    mode: 'DEEP',
    reason: 'VERY_HIGH_COMPLEXITY',
  });
});

test('CRITICAL risk always routes to CRITICAL', () => {
  const inputs: AiTaskRoutingInput[] = [
    { ...trivialInput, risk: 'CRITICAL' },
    {
      ambiguity: 'HIGH',
      complexity: 'VERY_HIGH',
      expectedEffort: 'LARGE',
      risk: 'CRITICAL',
      verificationNeed: 'HIGH',
    },
  ];
  for (const input of inputs) {
    assert.deepEqual(routeAiTask(input), { mode: 'CRITICAL', reason: 'CRITICAL_RISK' });
  }
});

test('high risk overrides otherwise-simple complexity', () => {
  assert.deepEqual(routeAiTask({ ...trivialInput, risk: 'HIGH' }), {
    mode: 'CRITICAL',
    reason: 'HIGH_RISK',
  });
});

test('identical input always produces an identical frozen decision', () => {
  const first = routeAiTask({ ...trivialInput, ambiguity: 'HIGH' });
  const second = routeAiTask({ ...trivialInput, ambiguity: 'HIGH' });
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});

test('routing logic contains no provider or model identity fields', () => {
  const source = readFileSync(new URL('./ai-mode-router.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /providerKey|modelKey|modelVersion/u);
  assert.deepEqual(Object.keys(routeAiTask(trivialInput)).sort(), ['mode', 'reason']);
});

test('invalid values, missing dimensions, and unsupported dimensions fail closed', () => {
  const invalidInputs: unknown[] = [
    { ...trivialInput, risk: 'UNKNOWN' },
    { ambiguity: 'LOW' },
    { ...trivialInput, score: 1 },
    null,
    [],
  ];
  for (const input of invalidInputs) {
    assert.throws(
      () => routeAiTask(input as AiTaskRoutingInput),
      (error: unknown) =>
        error instanceof AiModeRouterValidationError && error.code === 'routing_input_invalid',
    );
  }
});

test('FAST, BALANCED, DEEP, and CRITICAL are all reachable', () => {
  assert.deepEqual(
    new Set([
      routeAiTask(trivialInput).mode,
      routeAiTask({ ...trivialInput, complexity: 'MEDIUM' }).mode,
      routeAiTask({ ...trivialInput, complexity: 'HIGH' }).mode,
      routeAiTask({ ...trivialInput, risk: 'CRITICAL' }).mode,
    ]),
    new Set(['FAST', 'BALANCED', 'DEEP', 'CRITICAL']),
  );
});

test('every decision returns a stable typed reason from the closed catalog', () => {
  const decisions = [
    routeAiTask(trivialInput),
    routeAiTask({ ...trivialInput, risk: 'MEDIUM' }),
    routeAiTask({ ...trivialInput, expectedEffort: 'LARGE' }),
    routeAiTask({ ...trivialInput, risk: 'HIGH' }),
  ];
  for (const result of decisions) {
    assert.ok(AI_TASK_ROUTING_REASONS.includes(result.reason));
  }
});
