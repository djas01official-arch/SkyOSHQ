import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeTenantName,
  normalizeTenantSlug,
  TenantInputValidationError,
} from './tenant-input';

test('tenant names and slugs normalize deterministically', () => {
  assert.equal(normalizeTenantName('  North   Star  ', 'Organization'), 'North Star');
  assert.equal(
    normalizeTenantSlug(' P\u0159\u00edli\u0161 \u017dlu\u0165ou\u010dk\u00fd / Team '),
    'prilis-zlutoucky-team',
  );
  assert.equal(normalizeTenantSlug('operations---emea'), 'operations-emea');
});

test('tenant input rejects empty and oversized normalized values', () => {
  assert.throws(() => normalizeTenantName('   ', 'Workspace'), TenantInputValidationError);
  assert.throws(
    () => normalizeTenantName('x'.repeat(121), 'Workspace'),
    TenantInputValidationError,
  );
  assert.throws(() => normalizeTenantSlug('---'), TenantInputValidationError);
  assert.throws(() => normalizeTenantSlug('x'.repeat(49)), TenantInputValidationError);
});
