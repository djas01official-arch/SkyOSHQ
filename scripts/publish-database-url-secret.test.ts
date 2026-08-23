import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDatabaseUrl,
  parseDatabaseUrlSecretPublisherArgs,
  publishDatabaseUrlSecret,
  type DatabaseUrlSecretPublisherConfig,
  type GcloudRunner,
} from './publish-database-url-secret';

const config: DatabaseUrlSecretPublisherConfig = {
  projectId: 'skyos-test-project',
  databaseHost: '10.20.30.40',
  databasePort: 5432,
  databaseName: 'skyos',
  databaseUser: 'skyos_application',
  passwordSecretId: 'skyos-np-db-application-password',
  runtimeSecretId: 'skyos-np-database-url',
};

test('buildDatabaseUrl encodes credentials without changing the private endpoint', () => {
  assert.equal(
    buildDatabaseUrl(config, 'p@ss:word/with?chars'),
    'postgresql://skyos_application:p%40ss%3Aword%2Fwith%3Fchars@10.20.30.40:5432/skyos',
  );
});

test('publisher keeps the database password out of gcloud command arguments', () => {
  const password = 'this_password_stays_in_memory_only_123456';
  const calls: Array<{ args: readonly string[]; input?: string }> = [];

  const runner: GcloudRunner = (args, input) => {
    calls.push({ args, input });

    if (args.includes('access')) return password;
    if (args.includes('add')) {
      return 'projects/skyos-test-project/secrets/skyos-np-database-url/versions/7';
    }

    return 'projects/skyos-test-project/secrets/example';
  };

  const version = publishDatabaseUrlSecret(config, runner);

  assert.equal(version, '7');
  assert.equal(calls.length, 4);
  assert.equal(
    calls.some(({ args }) => args.some((argument) => argument.includes(password))),
    false,
  );

  const publishCall = calls.at(-1);
  assert.ok(publishCall);
  assert.equal(
    publishCall.input,
    `postgresql://skyos_application:${password}@10.20.30.40:5432/skyos`,
  );
});

test('argument parser requires a private database endpoint', () => {
  assert.throws(() =>
    parseDatabaseUrlSecretPublisherArgs([
      '--project-id',
      'skyos-test-project',
      '--database-host',
      '8.8.8.8',
    ]),
  );

  assert.deepEqual(
    parseDatabaseUrlSecretPublisherArgs([
      '--project-id',
      'skyos-test-project',
      '--database-host',
      '10.1.2.3',
    ]),
    {
      ...config,
      databaseHost: '10.1.2.3',
    },
  );
});
