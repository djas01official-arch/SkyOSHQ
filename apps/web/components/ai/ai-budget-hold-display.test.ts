import assert from 'node:assert/strict';
import { test } from 'node:test';

import { getAiBudgetHoldPresentation } from './ai-budget-hold-display';

test('maps all current hold classifications to safe read-only operator language', () => {
  const cases = [
    ['RESOLVABLE_RELEASE_ZERO_ATTEMPT', 'Evidence supports release'],
    ['RESOLVABLE_SETTLE_KNOWN_COST', 'Evidence supports settlement'],
    ['BLOCKED_UNKNOWN_COST', 'Provider cost still unresolved'],
    ['BLOCKED_OVERRUN', 'Known cost exceeds reservation'],
    ['INDETERMINATE', 'Manual investigation required'],
  ] as const;

  for (const [classification, title] of cases) {
    const presentation = getAiBudgetHoldPresentation(classification, null);
    assert.equal(presentation.title, title);
    assert.doesNotMatch(
      `${presentation.title} ${presentation.description}`,
      /retry|resume|charge|debit/iu,
    );
  }
});
