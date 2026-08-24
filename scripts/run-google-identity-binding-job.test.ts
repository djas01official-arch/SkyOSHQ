import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBindingPayload,
  gcloudUsesShell,
  parseGoogleIdentityBindingJobArgs,
  readJwtSubject,
} from './run-google-identity-binding-job';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('reads only the Google subject from an identity token payload', () => {
  const token = `${encode({ alg: 'none' })}.${encode({ sub: 'google-subject-123', email: 'not-used' })}.sig`;
  assert.equal(readJwtSubject(token), 'google-subject-123');
});

test('requires explicit confirmation of the current gcloud Google account', () => {
  assert.throws(() =>
    parseGoogleIdentityBindingJobArgs(['--project-id', 'skyos-test-project']),
  );

  assert.deepEqual(
    parseGoogleIdentityBindingJobArgs([
      '--project-id',
      'skyos-test-project',
      '--confirm-current-google-account',
    ]),
    {
      projectId: 'skyos-test-project',
      region: 'europe-west1',
      webService: 'skyos-np-web',
      bootstrapJob: 'skyos-np-migrator-role-bootstrap',
      requestSecret: 'skyos-np-google-binding-request',
      confirmCurrentGoogleAccount: true,
    },
  );
});

test('binding payload preserves closed enrollment and single-user bootstrap guard', () => {
  const payload = buildBindingPayload();

  assert.match(payload, /bindGoogleIdentity/);
  assert.match(payload, /users\.length !== 1/);
  assert.match(payload, /Google identity binding job: PASS/);
  assert.doesNotMatch(payload, /email/i);
  assert.doesNotMatch(payload, /access_token|refresh_token|id_token/i);
});

test('gcloud uses the command shell only on Windows', () => {
  assert.equal(gcloudUsesShell('win32'), true);
  assert.equal(gcloudUsesShell('linux'), false);
  assert.equal(gcloudUsesShell('darwin'), false);
});
