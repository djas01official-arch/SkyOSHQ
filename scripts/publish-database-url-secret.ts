import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DATABASE_NAME = 'skyos';
const DEFAULT_DATABASE_USER = 'skyos_application';
const DEFAULT_DATABASE_PORT = 5432;
const DEFAULT_PASSWORD_SECRET_ID = 'skyos-np-db-application-password';
const DEFAULT_RUNTIME_SECRET_ID = 'skyos-np-database-url';

export type DatabaseUrlSecretPublisherConfig = Readonly<{
  projectId: string;
  databaseHost: string;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  passwordSecretId: string;
  runtimeSecretId: string;
}>;

export type GcloudRunner = (args: readonly string[], input?: string) => string;

function isPrivateIpv4Address(value: string): boolean {
  const octets = value.split('.');

  if (octets.length !== 4) return false;

  const numbers = octets.map((octet) => Number(octet));
  if (
    numbers.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== octets[index],
    )
  ) {
    return false;
  }

  const [first, second] = numbers;

  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validateIdentifier(value: string, label: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function validateSecretId(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

export function validateDatabaseUrlSecretPublisherConfig(
  config: DatabaseUrlSecretPublisherConfig,
): void {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) {
    throw new Error('projectId is invalid.');
  }

  if (!isPrivateIpv4Address(config.databaseHost)) {
    throw new Error('databaseHost must be a private IPv4 address.');
  }

  if (
    !Number.isInteger(config.databasePort) ||
    config.databasePort < 1 ||
    config.databasePort > 65535
  ) {
    throw new Error('databasePort is invalid.');
  }

  validateIdentifier(config.databaseName, 'databaseName');
  validateIdentifier(config.databaseUser, 'databaseUser');
  validateSecretId(config.passwordSecretId, 'passwordSecretId');
  validateSecretId(config.runtimeSecretId, 'runtimeSecretId');
}

export function buildDatabaseUrl(
  config: Pick<
    DatabaseUrlSecretPublisherConfig,
    'databaseHost' | 'databasePort' | 'databaseName' | 'databaseUser'
  >,
  password: string,
): string {
  if (password.length === 0) {
    throw new Error('Database password is unavailable.');
  }

  return `postgresql://${encodeURIComponent(config.databaseUser)}:${encodeURIComponent(password)}@${config.databaseHost}:${config.databasePort}/${encodeURIComponent(config.databaseName)}`;
}

function runGcloud(args: readonly string[], input?: string): string {
  const executable = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';
  const result = spawnSync(executable, [...args], {
    encoding: 'utf8',
    input,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('A gcloud command failed while publishing the database runtime secret.');
  }

  return result.stdout.trim();
}

function requireSecret(runner: GcloudRunner, projectId: string, secretId: string): void {
  runner([
    'secrets',
    'describe',
    secretId,
    '--project',
    projectId,
    '--format=value(name)',
  ]);
}

export function publishDatabaseUrlSecret(
  config: DatabaseUrlSecretPublisherConfig,
  runner: GcloudRunner = runGcloud,
): string {
  validateDatabaseUrlSecretPublisherConfig(config);
  requireSecret(runner, config.projectId, config.passwordSecretId);
  requireSecret(runner, config.projectId, config.runtimeSecretId);

  const password = runner([
    'secrets',
    'versions',
    'access',
    'latest',
    '--secret',
    config.passwordSecretId,
    '--project',
    config.projectId,
  ]).trim();

  const databaseUrl = buildDatabaseUrl(config, password);
  const versionResource = runner(
    [
      'secrets',
      'versions',
      'add',
      config.runtimeSecretId,
      '--project',
      config.projectId,
      '--data-file=-',
      '--format=value(name)',
    ],
    databaseUrl,
  );
  const version = versionResource.split('/').at(-1) ?? '';

  if (!/^[1-9][0-9]*$/.test(version)) {
    throw new Error('The database runtime secret version could not be verified.');
  }

  return version;
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_DATABASE_PORT;

  const port = Number(value);
  return Number.isInteger(port) ? port : Number.NaN;
}

export function parseDatabaseUrlSecretPublisherArgs(
  argv: readonly string[],
): DatabaseUrlSecretPublisherConfig {
  const projectId = readFlag(argv, '--project-id');
  const databaseHost = readFlag(argv, '--database-host');

  if (!projectId || !databaseHost) {
    throw new Error('Required operator arguments are missing.');
  }

  const config: DatabaseUrlSecretPublisherConfig = {
    projectId,
    databaseHost,
    databasePort: parsePort(readFlag(argv, '--database-port')),
    databaseName: readFlag(argv, '--database-name') ?? DEFAULT_DATABASE_NAME,
    databaseUser: readFlag(argv, '--database-user') ?? DEFAULT_DATABASE_USER,
    passwordSecretId:
      readFlag(argv, '--password-secret') ?? DEFAULT_PASSWORD_SECRET_ID,
    runtimeSecretId: readFlag(argv, '--runtime-secret') ?? DEFAULT_RUNTIME_SECRET_ID,
  };

  validateDatabaseUrlSecretPublisherConfig(config);
  return config;
}

async function main(): Promise<void> {
  try {
    const config = parseDatabaseUrlSecretPublisherArgs(process.argv.slice(2));
    const version = publishDatabaseUrlSecret(config);
    console.log(`DATABASE_URL Secret Manager version: ${version}`);
  } catch {
    console.error('DATABASE_URL secret publication failed.');
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (entryPoint === import.meta.url) {
  void main();
}
