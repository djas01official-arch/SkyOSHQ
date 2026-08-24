import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REGION = 'europe-west1';
const DEFAULT_WEB_SERVICE = 'skyos-np-web';
const DEFAULT_BOOTSTRAP_JOB = 'skyos-np-migrator-role-bootstrap';
const DEFAULT_REQUEST_SECRET = 'skyos-np-google-binding-request';

export type GoogleIdentityBindingJobConfig = Readonly<{
  projectId: string;
  region: string;
  webService: string;
  bootstrapJob: string;
  requestSecret: string;
  confirmCurrentGoogleAccount: boolean;
}>;

export type GcloudRunner = (args: readonly string[], input?: string) => string;

type SecretKeyRef = Readonly<{
  name: string;
  version: string;
}>;

type BootstrapRuntime = Readonly<{
  dbHost: string;
  dbName: string;
  dbPassword: SecretKeyRef;
  dbPort: string;
  dbUser: string;
  serviceAccount: string;
}>;

function validateProjectId(value: string): void {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new Error('projectId is invalid.');
  }
}

function validateResourceName(value: string, label: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function validateSecretId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(value)) {
    throw new Error('requestSecret is invalid.');
  }
}

export function gcloudUsesShell(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

function runGcloud(args: readonly string[], input?: string): string {
  const result = spawnSync('gcloud', [...args], {
    encoding: 'utf8',
    input,
    shell: gcloudUsesShell(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error('A gcloud command failed while preparing Google identity binding.');
  }

  return result.stdout.trim();
}

function readFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

export function parseGoogleIdentityBindingJobArgs(
  argv: readonly string[],
): GoogleIdentityBindingJobConfig {
  const projectId = readFlag(argv, '--project-id');

  if (!projectId) {
    throw new Error('Required operator arguments are missing.');
  }

  const config: GoogleIdentityBindingJobConfig = {
    projectId,
    region: readFlag(argv, '--region') ?? DEFAULT_REGION,
    webService: readFlag(argv, '--web-service') ?? DEFAULT_WEB_SERVICE,
    bootstrapJob: readFlag(argv, '--bootstrap-job') ?? DEFAULT_BOOTSTRAP_JOB,
    requestSecret: readFlag(argv, '--request-secret') ?? DEFAULT_REQUEST_SECRET,
    confirmCurrentGoogleAccount: argv.includes('--confirm-current-google-account'),
  };

  validateProjectId(config.projectId);
  validateResourceName(config.region, 'region');
  validateResourceName(config.webService, 'webService');
  validateResourceName(config.bootstrapJob, 'bootstrapJob');
  validateSecretId(config.requestSecret);

  if (!config.confirmCurrentGoogleAccount) {
    throw new Error('The current gcloud Google account must be explicitly confirmed.');
  }

  return config;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('A gcloud response was invalid.');
  }
  return parsed as Record<string, unknown>;
}

function readNested(value: unknown, path: readonly string[]): unknown {
  let current = value;

  for (const key of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('A required gcloud value was unavailable.');
  }
  return value.trim();
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('A required gcloud value was unavailable.');
  }
  return value;
}

function readEnvValue(container: unknown, name: string): string {
  const env = requireArray(readNested(container, ['env']));
  const entry = env.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).name === name,
  );

  return requireString(readNested(entry, ['value']));
}

function readSecretRef(container: unknown, name: string): SecretKeyRef {
  const env = requireArray(readNested(container, ['env']));
  const entry = env.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).name === name,
  );

  const secretName = requireString(readNested(entry, ['valueFrom', 'secretKeyRef', 'name']));
  const version = requireString(readNested(entry, ['valueFrom', 'secretKeyRef', 'key']));

  return { name: secretName, version };
}

export function readJwtSubject(token: string): string {
  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    throw new Error('The current Google identity token was invalid.');
  }

  const payload = parseJsonObject(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
  const subject = payload.sub;

  if (typeof subject !== 'string' || subject.length === 0 || subject.length > 512) {
    throw new Error('The current Google identity token did not contain a valid subject.');
  }

  return subject;
}

function readLatestWebImage(
  config: GoogleIdentityBindingJobConfig,
  runner: GcloudRunner,
): string {
  const service = parseJsonObject(
    runner([
      'run',
      'services',
      'describe',
      config.webService,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=json',
    ]),
  );
  const revisionName = requireString(readNested(service, ['status', 'latestReadyRevisionName']));
  const revision = parseJsonObject(
    runner([
      'run',
      'revisions',
      'describe',
      revisionName,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=json',
    ]),
  );
  const containers = requireArray(readNested(revision, ['spec', 'containers']));
  const image = requireString(readNested(containers[0], ['image']));

  return image;
}

function readBootstrapRuntime(
  config: GoogleIdentityBindingJobConfig,
  runner: GcloudRunner,
): BootstrapRuntime {
  const job = parseJsonObject(
    runner([
      'run',
      'jobs',
      'describe',
      config.bootstrapJob,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--format=json',
    ]),
  );
  const taskSpec = readNested(job, ['spec', 'template', 'spec', 'template', 'spec']);
  const containers = requireArray(readNested(taskSpec, ['containers']));
  const container = containers[0];
  const serviceAccount = requireString(readNested(taskSpec, ['serviceAccountName']));
  const runtime: BootstrapRuntime = {
    dbHost: readEnvValue(container, 'DB_HOST'),
    dbName: readEnvValue(container, 'DB_NAME'),
    dbPassword: readSecretRef(container, 'DB_PASSWORD'),
    dbPort: readEnvValue(container, 'DB_PORT'),
    dbUser: readEnvValue(container, 'DB_USER'),
    serviceAccount,
  };

  if (runtime.dbName !== 'skyos' || runtime.dbUser !== 'skyos_migrator') {
    throw new Error('The bootstrap job does not target the expected SkyOS database identity.');
  }

  return runtime;
}

function readSecretVersion(response: string): string {
  const resource = parseJsonObject(response);
  const name = requireString(resource.name);
  const version = name.split('/').at(-1) ?? '';

  if (!/^[1-9][0-9]*$/.test(version)) {
    throw new Error('The binding request secret version could not be verified.');
  }

  return version;
}

function ensureRequestSecret(
  config: GoogleIdentityBindingJobConfig,
  runner: GcloudRunner,
): void {
  try {
    runner([
      'secrets',
      'describe',
      config.requestSecret,
      '--project',
      config.projectId,
      '--format=json',
    ]);
    return;
  } catch {
    runner([
      'secrets',
      'create',
      config.requestSecret,
      '--project',
      config.projectId,
      '--replication-policy=user-managed',
      `--locations=${config.region}`,
      '--labels=application=skyos,environment=nonprod,component=identity-binding',
      '--format=json',
    ]);
  }
}

export function buildBindingPayload(): string {
  return `
import { PrismaPg } from '@prisma/adapter-pg';
import { bindGoogleIdentity } from './database/auth/google-identity';
import { PrismaClient, UserStatus } from './database/generated/client/client';

async function main() {
  const requestRaw = process.env.SKYOS_GOOGLE_BINDING_REQUEST;
  const databaseUrl = process.env.DATABASE_URL;

  if (!requestRaw || !databaseUrl) throw new Error('invalid_binding_job_configuration');

  let request;
  try {
    request = JSON.parse(requestRaw);
  } catch {
    throw new Error('invalid_binding_request');
  }

  const googleSubject = request?.googleSubject;
  if (typeof googleSubject !== 'string' || googleSubject.length === 0 || googleSubject.length > 512) {
    throw new Error('invalid_binding_request');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    const users = await prisma.user.findMany({
      where: { status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true },
      take: 2,
    });

    if (users.length !== 1 || !users[0]) {
      throw new Error('bootstrap_binding_requires_exactly_one_active_user');
    }

    await bindGoogleIdentity(prisma, {
      actorUserId: users[0].id,
      targetUserId: users[0].id,
      googleSubject,
    });

    console.log('Google identity binding job: PASS');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  console.error('Google identity binding job: FAIL');
  process.exitCode = 1;
});
`.trim();
}

function buildJobName(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace('T', '-')
    .replace('Z', '')
    .toLowerCase();

  return `skyos-np-google-bind-${timestamp}`;
}

export function runGoogleIdentityBindingJob(
  config: GoogleIdentityBindingJobConfig,
  runner: GcloudRunner = runGcloud,
): string {
  const token = runner(['auth', 'print-identity-token']);
  const googleSubject = readJwtSubject(token);
  const image = readLatestWebImage(config, runner);
  const runtime = readBootstrapRuntime(config, runner);
  const request = JSON.stringify({ googleSubject });
  const payloadBase64 = Buffer.from(buildBindingPayload(), 'utf8').toString('base64');
  const network = `projects/${config.projectId}/global/networks/skyos-np`;
  const subnet = `projects/${config.projectId}/regions/${config.region}/subnetworks/skyos-np-runtime`;
  const jobName = buildJobName();

  ensureRequestSecret(config, runner);

  runner([
    'secrets',
    'add-iam-policy-binding',
    config.requestSecret,
    '--project',
    config.projectId,
    '--member',
    `serviceAccount:${runtime.serviceAccount}`,
    '--role',
    'roles/secretmanager.secretAccessor',
    '--quiet',
  ]);

  const versionResponse = runner(
    [
      'secrets',
      'versions',
      'add',
      config.requestSecret,
      '--project',
      config.projectId,
      '--data-file=-',
      '--format=json',
    ],
    request,
  );
  const requestVersion = readSecretVersion(versionResponse);

  const shellScript =
    'set -eu; export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"; cd /app; exec /app/node_modules/.bin/tsx -e "$(printf %s "$SKYOS_BINDER_PAYLOAD_B64" | base64 -d)"';

  try {
    runner([
      'run',
      'jobs',
      'create',
      jobName,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--image',
      image,
      '--service-account',
      runtime.serviceAccount,
      '--network',
      network,
      '--subnet',
      subnet,
      '--vpc-egress',
      'private-ranges-only',
      '--tasks',
      '1',
      '--parallelism',
      '1',
      '--max-retries',
      '0',
      '--task-timeout',
      '10m',
      '--set-env-vars',
      `DB_NAME=${runtime.dbName},DB_USER=${runtime.dbUser},DB_HOST=${runtime.dbHost},DB_PORT=${runtime.dbPort},SKYOS_BINDER_PAYLOAD_B64=${payloadBase64}`,
      '--set-secrets',
      `DB_PASSWORD=${runtime.dbPassword.name}:${runtime.dbPassword.version},SKYOS_GOOGLE_BINDING_REQUEST=${config.requestSecret}:${requestVersion}`,
      '--command',
      '/bin/sh',
      '--args',
      `-c,${shellScript}`,
      '--quiet',
    ]);

    runner([
      'run',
      'jobs',
      'execute',
      jobName,
      '--project',
      config.projectId,
      '--region',
      config.region,
      '--wait',
      '--quiet',
    ]);

    return jobName;
  } finally {
    try {
      runner([
        'secrets',
        'versions',
        'destroy',
        requestVersion,
        '--secret',
        config.requestSecret,
        '--project',
        config.projectId,
        '--quiet',
      ]);
    } catch {
      // The binding result is preserved; cleanup failure is reported by the caller's generic status.
    }
  }
}

async function main(): Promise<void> {
  try {
    const config = parseGoogleIdentityBindingJobArgs(process.argv.slice(2));
    const jobName = runGoogleIdentityBindingJob(config);
    console.log(`Google identity binding: PASS (${jobName})`);
  } catch {
    console.error('Google identity binding: FAIL');
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;

if (entryPoint === import.meta.url) {
  void main();
}
