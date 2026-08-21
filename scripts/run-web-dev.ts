import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { runLocalDevelopmentAuthPreflight } from './local-dev-auth-preflight';
import {
  getLocalDevelopmentEnvironmentDiagnostics,
  getRepositoryRoot,
  loadAuthoritativeLocalDevelopmentEnvironment,
  type LocalDevelopmentEnvironment,
} from './local-dev-environment';

export type WebDevInvocation = Readonly<{
  args: readonly string[];
  command: string;
  cwd: string;
  environment: NodeJS.ProcessEnv;
}>;

export function createWebDevInvocation(
  environment: NodeJS.ProcessEnv,
  cliArguments: readonly string[],
  repositoryRoot = getRepositoryRoot(),
): WebDevInvocation {
  const nodeRequire = createRequire(resolve(repositoryRoot, 'package.json'));
  const nextCliPath = nodeRequire.resolve('next/dist/bin/next');
  return Object.freeze({
    args: Object.freeze([nextCliPath, 'dev', ...cliArguments]),
    command: process.execPath,
    cwd: resolve(repositoryRoot, 'apps/web'),
    environment,
  });
}

export function startWebDevProcess(invocation: WebDevInvocation): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.environment,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export async function runAuthoritativeWebDev(
  cliArguments: readonly string[],
  dependencies: Readonly<{
    loadEnvironment?: () => LocalDevelopmentEnvironment;
    preflight?: (environment: {
      AUTH_DEV_EMAIL: string;
      AUTH_DEV_PASSWORD: string;
      DATABASE_URL: string;
    }) => Promise<void>;
    startProcess?: (invocation: WebDevInvocation) => Promise<number>;
  }> = {},
): Promise<number> {
  const loaded = (dependencies.loadEnvironment ?? loadAuthoritativeLocalDevelopmentEnvironment)();
  for (const diagnostic of getLocalDevelopmentEnvironmentDiagnostics()) {
    console.log(diagnostic);
  }

  await (dependencies.preflight ?? runLocalDevelopmentAuthPreflight)({
    AUTH_DEV_EMAIL: loaded.environment.AUTH_DEV_EMAIL!,
    AUTH_DEV_PASSWORD: loaded.environment.AUTH_DEV_PASSWORD!,
    DATABASE_URL: loaded.environment.DATABASE_URL!,
  });
  const invocation = createWebDevInvocation(loaded.environment, cliArguments);
  return (dependencies.startProcess ?? startWebDevProcess)(invocation);
}

async function main(): Promise<void> {
  process.exitCode = await runAuthoritativeWebDev(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : 'SkyOS local web development failed to start.',
    );
    process.exitCode = 1;
  });
}
