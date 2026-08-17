import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getAiBudgetReservationHoldReasonDisplay,
  getAiExecutionRecoveryPresentation,
} from './ai-execution-recovery-display';

test('maps persisted recovery classifications to safe operator language', () => {
  const cases = [
    ['ZERO_ATTEMPT_PROVEN', null, 'No provider attempt recorded'],
    ['ATTEMPTED_KNOWN_COST', null, 'Provider attempt recorded — cost known'],
    ['ATTEMPTED_UNKNOWN_COST', null, 'Provider attempt recorded — cost unresolved'],
    ['TERMINAL_FINANCIAL_STATE', null, 'Financial state already terminal'],
    ['INDETERMINATE', 'EXECUTION_LINEAGE_MISMATCH', 'Manual investigation required'],
  ] as const;

  for (const [classification, reason, title] of cases) {
    const presentation = getAiExecutionRecoveryPresentation(classification, reason);
    assert.equal(presentation.title, title);
    assert.doesNotMatch(
      `${presentation.title} ${presentation.description}`,
      /retry|safe to rerun/iu,
    );
  }
});

test('maps durable budget hold reasons to safe operator language', () => {
  assert.equal(
    getAiBudgetReservationHoldReasonDisplay('UNKNOWN_PROVIDER_COST'),
    'Budget is held because provider cost is unresolved.',
  );
  assert.equal(
    getAiBudgetReservationHoldReasonDisplay('ACTUAL_COST_OVERRUN'),
    'Budget is held because recorded provider cost exceeded the reserved amount.',
  );
  assert.equal(
    getAiBudgetReservationHoldReasonDisplay('ACCOUNTING_UNRESOLVED'),
    'Budget is held because accounting requires manual resolution.',
  );
});

test('maps indeterminate reasons without exposing persistence internals', () => {
  const presentation = getAiExecutionRecoveryPresentation(
    'INDETERMINATE',
    'MULTI_ORCHESTRATION_LINEAGE_INVALID',
  );
  assert.equal(presentation.description, 'Orchestration evidence is inconsistent.');
  assert.doesNotMatch(presentation.description, /foreign key|table|database/iu);
});
