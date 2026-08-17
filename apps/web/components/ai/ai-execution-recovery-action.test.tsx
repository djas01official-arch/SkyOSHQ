import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const recoverableClassifications = [
  'ZERO_ATTEMPT_PROVEN',
  'ATTEMPTED_KNOWN_COST',
  'ATTEMPTED_UNKNOWN_COST',
  'TERMINAL_FINANCIAL_STATE',
] as const;

test('shows the explicit terminal Recover control only for safely recoverable classifications', async () => {
  Object.assign(globalThis, { React });
  const { AiExecutionRecoveryAction } = await import('./ai-execution-recovery-action');
  for (const classification of recoverableClassifications) {
    const executionClaimId = randomUUID();
    const html = renderToStaticMarkup(
      <AiExecutionRecoveryAction
        classification={classification}
        executionClaimId={executionClaimId}
      />,
    );
    assert.match(html, />Recover</u);
    assert.match(
      html,
      new RegExp(
        `<input(?=[^>]*\\bname="executionClaimId")(?=[^>]*\\bvalue="${executionClaimId}")[^>]*>`,
        'u',
      ),
    );
    assert.doesNotMatch(html, />Retry(?: AI)?</iu);
    assert.doesNotMatch(html, />Resume</iu);
    assert.doesNotMatch(html, />Start over</iu);
  }
});

test('does not render an enabled recovery control for indeterminate persisted evidence', async () => {
  Object.assign(globalThis, { React });
  const { AiExecutionRecoveryAction } = await import('./ai-execution-recovery-action');
  const html = renderToStaticMarkup(
    <AiExecutionRecoveryAction classification="INDETERMINATE" executionClaimId={randomUUID()} />,
  );
  assert.doesNotMatch(html, />Recover</u);
  assert.match(html, /Manual investigation required/u);
  assert.doesNotMatch(html, />Retry(?: AI)?</iu);
  assert.doesNotMatch(html, />Resume</iu);
});
