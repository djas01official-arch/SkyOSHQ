import { resolve } from 'node:path';

import { loadAuthoritativeLocalDevelopmentEnvironment } from './local-dev-environment';
import { runLocalDevelopmentAuthPreflight } from './local-dev-auth-preflight';

export async function checkLocalDevelopmentAuthentication(
  loaded = loadAuthoritativeLocalDevelopmentEnvironment(),
): Promise<void> {
  await runLocalDevelopmentAuthPreflight({
    AUTH_DEV_EMAIL: loaded.environment.AUTH_DEV_EMAIL!,
    AUTH_DEV_PASSWORD: loaded.environment.AUTH_DEV_PASSWORD!,
    DATABASE_URL: loaded.environment.DATABASE_URL!,
  });
}

async function main(): Promise<void> {
  await checkLocalDevelopmentAuthentication();
  console.log('Local development credentials: READY');
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  void main().catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? error.message
        : 'Local development credentials could not be checked.',
    );
    process.exitCode = 1;
  });
}
