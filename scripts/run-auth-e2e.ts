import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const REPOSITORY_ROOT = process.cwd();
const nodeRequire = createRequire(resolve(REPOSITORY_ROOT, 'package.json'));
const prismaCliPath = nodeRequire.resolve('prisma/build/index.js');
const tsxCliPath = nodeRequire.resolve('tsx/cli');
const testPath = resolve(REPOSITORY_ROOT, 'apps/web/tests/authentication.e2e.test.ts');

function getGenerationDatabaseUrl(): string {
  const adminDatabaseUrl = process.env.AUTH_E2E_DATABASE_ADMIN_URL;

  if (!adminDatabaseUrl) {
    throw new Error(
      'AUTH_E2E_DATABASE_ADMIN_URL is required to run black-box authentication tests.',
    );
  }

  const generationUrl = new URL(adminDatabaseUrl);
  generationUrl.pathname = '/skyos_auth_e2e_generation_placeholder';
  generationUrl.searchParams.set('schema', 'public');
  return generationUrl.toString();
}

function run(
  label: string,
  entrypoint: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(
        new Error(`${label} exited with code ${code ?? 'none'} and signal ${signal ?? 'none'}.`),
      );
    });
  });
}

async function main(): Promise<void> {
  await run('Prisma Client generation', prismaCliPath, ['generate'], {
    ...process.env,
    DATABASE_URL: getGenerationDatabaseUrl(),
  });
  await run(
    'Black-box application test process',
    tsxCliPath,
    ['--test', '--test-concurrency=1', testPath],
    process.env,
  );
}

void main().catch((error: unknown) => {
  console.error('Black-box application tests failed to run.');
  console.error(error instanceof Error ? error.message : 'Unknown runner error.');
  process.exitCode = 1;
});
