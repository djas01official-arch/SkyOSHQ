import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { createWebDevInvocation, runAuthoritativeWebDev } from './run-web-dev';

const environment = {
  AUTH_DEV_EMAIL: 'developer@example.test',
  AUTH_DEV_PASSWORD: 'root-password-only-value',
  AUTH_SECRET: 'root-secret-only-value',
  DATABASE_URL: 'postgresql://root-only-value',
  PATH: 'preserved-path',
};

test('web dev invocation forwards CLI arguments exactly without putting environment values in the command', () => {
  const invocation = createWebDevInvocation(environment, [
    '--hostname',
    '203.0.113.12',
    '--port',
    '3000',
  ]);

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [
    'dev',
    '--hostname',
    '203.0.113.12',
    '--port',
    '3000',
  ]);
  assert.equal(invocation.environment.PATH, 'preserved-path');
  assert.doesNotMatch(
    JSON.stringify({ args: invocation.args, command: invocation.command }),
    /root-(?:password|secret)-only-value/u,
  );
});

test('authoritative launcher performs its read-only preflight before starting the child process and never seeds', async () => {
  const calls: string[] = [];
  const exitCode = await runAuthoritativeWebDev(['--port', '3010'], {
    loadEnvironment: () => ({ environment, environmentPath: 'C:/skyos/.env' }),
    preflight: async (preflightEnvironment) => {
      calls.push(`preflight:${preflightEnvironment.DATABASE_URL}`);
    },
    startProcess: async (invocation) => {
      calls.push(`start:${invocation.args.join(' ')}`);
      return 7;
    },
  });

  assert.equal(exitCode, 7);
  assert.equal(calls[0], 'preflight:postgresql://root-only-value');
  assert.match(calls[1]!, /^start:.*next dev --port 3010$/u);
  assert.doesNotMatch(readFileSync(resolve(__dirname, 'run-web-dev.ts'), 'utf8'), /db:seed/u);
});

test('production and workspace development scripts remain unchanged', () => {
  const rootPackage = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };
  const webPackage = JSON.parse(
    readFileSync(resolve(__dirname, '..', 'apps', 'web', 'package.json'), 'utf8'),
  ) as {
    scripts: Record<string, string>;
  };

  assert.equal(rootPackage.scripts.dev, 'turbo run dev --parallel');
  assert.equal(webPackage.scripts.dev, 'next dev');
  assert.equal(rootPackage.scripts['dev:web'], 'tsx scripts/run-web-dev.ts');
});
