import 'dotenv/config';

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const prismaCliPath = nodeRequire.resolve('prisma/build/index.js');

function getTestDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_TEST_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_TEST_URL is required to run database integration tests.');
  }

  const databaseName = new URL(databaseUrl).pathname;

  if (databaseName !== '/skyos_test') {
    throw new Error('DATABASE_TEST_URL must target the dedicated skyos_test database.');
  }

  if (databaseUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_TEST_URL must not match DATABASE_URL.');
  }

  return databaseUrl;
}

function applyMigrations(databaseUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const migration = spawn(process.execPath, [prismaCliPath, 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });

    migration.once('error', reject);
    migration.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Prisma test migration exited with code ${code ?? 'unknown'}.`));
    });
  });
}

async function main(): Promise<void> {
  await applyMigrations(getTestDatabaseUrl());
}

void main().catch((error: unknown) => {
  console.error('Test database migration failed.');

  if (error instanceof Error) {
    console.error(error.message);
  }

  process.exitCode = 1;
});
