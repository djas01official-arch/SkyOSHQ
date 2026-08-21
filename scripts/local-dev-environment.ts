import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { parse } from 'dotenv';

const REQUIRED_LOCAL_WEB_ENVIRONMENT_NAMES = [
  'DATABASE_URL',
  'AUTH_SECRET',
  'AUTH_DEV_EMAIL',
  'AUTH_DEV_PASSWORD',
] as const;

export type RequiredLocalWebEnvironmentName = (typeof REQUIRED_LOCAL_WEB_ENVIRONMENT_NAMES)[number];

export class LocalDevelopmentEnvironmentError extends Error {
  readonly code: 'local_development_environment_missing' | 'local_development_environment_invalid';

  constructor(code: LocalDevelopmentEnvironmentError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type LocalDevelopmentEnvironment = Readonly<{
  environment: NodeJS.ProcessEnv;
  environmentPath: string;
}>;

export function getRepositoryRoot(from = __filename): string {
  return resolve(dirname(from), '..');
}

export function getLocalDevelopmentEnvironmentDiagnostics(): readonly string[] {
  return REQUIRED_LOCAL_WEB_ENVIRONMENT_NAMES.map((name) => `${name}: PRESENT`);
}

function validateRequiredLocalWebEnvironment(environment: Record<string, string>): void {
  for (const name of REQUIRED_LOCAL_WEB_ENVIRONMENT_NAMES) {
    if (!environment[name]?.trim()) {
      throw new LocalDevelopmentEnvironmentError(
        'local_development_environment_invalid',
        `Local development environment is missing required variable ${name}.`,
      );
    }
  }
}

/**
 * Loads the monorepo-root .env into a child-only environment. Root .env values
 * intentionally override inherited shell values for local web development.
 */
export function loadAuthoritativeLocalDevelopmentEnvironment(
  options: Readonly<{
    inheritedEnvironment?: NodeJS.ProcessEnv;
    readFile?: (path: string) => string;
    repositoryRoot?: string;
  }> = {},
): LocalDevelopmentEnvironment {
  const environmentPath = resolve(options.repositoryRoot ?? getRepositoryRoot(), '.env');
  let source: string;
  try {
    source = (options.readFile ?? ((path) => readFileSync(path, 'utf8')))(environmentPath);
  } catch {
    throw new LocalDevelopmentEnvironmentError(
      'local_development_environment_missing',
      'Local development .env was not found. Copy .env.example to .env and configure it.',
    );
  }

  let fileEnvironment: Record<string, string>;
  try {
    fileEnvironment = parse(source);
  } catch {
    throw new LocalDevelopmentEnvironmentError(
      'local_development_environment_invalid',
      'Local development .env could not be parsed.',
    );
  }

  validateRequiredLocalWebEnvironment(fileEnvironment);
  const environment = { ...(options.inheritedEnvironment ?? process.env), ...fileEnvironment };
  return Object.freeze({ environment, environmentPath });
}
