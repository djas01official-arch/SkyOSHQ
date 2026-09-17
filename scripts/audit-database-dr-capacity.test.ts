import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditScripts = [
  'scripts/audit-database-dr-capacity.ps1',
  'scripts/audit-database-dr-capacity.sh',
] as const;

const requiredReadOnlyFragments = [
  'gcloud auth list',
  'gcloud config get-value project',
  'gcloud sql instances describe',
  'gcloud sql backups list',
  'gcloud sql operations list',
  'gcloud run services describe',
  'gcloud run worker-pools describe',
  'gcloud run jobs describe',
  'gcloud secrets list',
  'SELECT setting::int AS max_connections',
  'FROM pg_stat_activity',
] as const;

const forbiddenMutationOrSecretPayloadPatterns = [
  /gcloud\s+secrets\s+versions\s+access/iu,
  /gcloud\s+sql\s+instances\s+(?:clone|create|delete|patch|restart|restore)/iu,
  /gcloud\s+sql\s+backups\s+(?:create|delete|restore)/iu,
  /gcloud\s+run\s+services\s+(?:delete|replace|update)/iu,
  /gcloud\s+(?:beta\s+)?run\s+worker-pools\s+(?:delete|replace|update)/iu,
  /gcloud\s+run\s+jobs\s+(?:delete|deploy|execute|replace|update)/iu,
] as const;

for (const scriptPath of auditScripts) {
  test(`${scriptPath} remains a read-only Task 9 evidence collector`, async () => {
    const source = await readFile(scriptPath, 'utf8');

    for (const fragment of requiredReadOnlyFragments) {
      assert.match(source, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }

    for (const forbiddenPattern of forbiddenMutationOrSecretPayloadPatterns) {
      assert.doesNotMatch(source, forbiddenPattern);
    }

    assert.match(source, /does not access Secret Manager payloads/iu);
    assert.match(source, /active gcloud project/iu);
  });
}

test('Cloud Shell audit fails fast and uses strict shell mode', async () => {
  const source = await readFile('scripts/audit-database-dr-capacity.sh', 'utf8');

  assert.match(source, /^#!\/usr\/bin\/env bash$/mu);
  assert.match(source, /^set -euo pipefail$/mu);
  assert.match(source, /require_command gcloud/u);
});
