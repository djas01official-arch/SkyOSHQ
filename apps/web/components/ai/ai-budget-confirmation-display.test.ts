import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatAiBudgetConfirmationUsd,
  getAiBudgetConfirmationPresentation,
} from './ai-budget-confirmation-display';

test('formats exact fixed-precision confirmation money without floating-point rounding', () => {
  assert.equal(formatAiBudgetConfirmationUsd('0.004900000000'), '$0.0049');
  assert.equal(formatAiBudgetConfirmationUsd('1.000000000000'), '$1');
  assert.equal(formatAiBudgetConfirmationUsd('0.000000000001'), '$0.000000000001');
});

test('rejects malformed confirmation money rather than displaying a misleading amount', () => {
  for (const value of ['0', '0.0049', '-0.004900000000', '0.0000000000000', 'NaN']) {
    assert.equal(formatAiBudgetConfirmationUsd(value), null);
  }
});

test('presents Continue only for authoritative approved states that have not started', () => {
  assert.deepEqual(getAiBudgetConfirmationPresentation('PENDING', 'NOT_STARTED'), {
    description: 'Approve this exact maximum budget proposal before SkyOS can continue.',
    showContinue: false,
    title: 'Confirmation required',
  });
  for (const executionState of ['NOT_STARTED', 'READY'] as const) {
    assert.equal(
      getAiBudgetConfirmationPresentation('APPROVED', executionState).showContinue,
      true,
    );
  }
  for (const executionState of ['STARTED', 'FINISHED'] as const) {
    assert.equal(
      getAiBudgetConfirmationPresentation('APPROVED', executionState).showContinue,
      false,
    );
  }
  assert.equal(
    getAiBudgetConfirmationPresentation('APPROVED', 'RECONFIRMATION_REQUIRED').showContinue,
    false,
  );
  assert.equal(getAiBudgetConfirmationPresentation('REJECTED', 'NOT_STARTED').showContinue, false);
});
