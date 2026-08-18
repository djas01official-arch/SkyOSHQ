import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const resolvableClassifications = [
  'RESOLVABLE_RELEASE_ZERO_ATTEMPT',
  'RESOLVABLE_SETTLE_KNOWN_COST',
] as const;

test('renders Resolve with only a reservation ID for evidence-resolvable holds', async () => {
  Object.assign(globalThis, { React });
  const { AiBudgetHoldResolveAction } = await import('./ai-budget-hold-resolve-action');

  for (const classification of resolvableClassifications) {
    const reservationId = randomUUID();
    const html = renderToStaticMarkup(
      <AiBudgetHoldResolveAction classification={classification} reservationId={reservationId} />,
    );
    assert.match(html, /data-ai-budget-hold-action="resolve"/u);
    assert.match(html, />Resolve</u);
    assert.match(
      html,
      new RegExp(
        `<input(?=[^>]*\\bname="reservationId")(?=[^>]*\\bvalue="${reservationId}")[^>]*>`,
        'u',
      ),
    );
    assert.doesNotMatch(
      html,
      /(?:actualCostUsd|workspaceId|operatorUserId|classification|holdReason)/u,
    );
    assert.doesNotMatch(html, /(?:>Settle<|>Release<|>Retry(?: AI)?<|>Resume<)/iu);
  }
});

test('does not render enabled Resolve controls for blocked or indeterminate persisted evidence', async () => {
  Object.assign(globalThis, { React });
  const { AiBudgetHoldResolveAction } = await import('./ai-budget-hold-resolve-action');

  for (const classification of [
    'BLOCKED_UNKNOWN_COST',
    'BLOCKED_OVERRUN',
    'INDETERMINATE',
  ] as const) {
    const html = renderToStaticMarkup(
      <AiBudgetHoldResolveAction classification={classification} reservationId={randomUUID()} />,
    );
    assert.doesNotMatch(html, /data-ai-budget-hold-action="resolve"/u);
    assert.doesNotMatch(html, />Resolve</u);
    assert.doesNotMatch(html, /<input[^>]*type="number"/iu);
    assert.doesNotMatch(html, /(?:>Settle<|>Release<|>Retry(?: AI)?<|>Resume<)/iu);
  }
});
