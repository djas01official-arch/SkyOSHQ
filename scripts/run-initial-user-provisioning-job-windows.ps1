param(
  [string]$ProjectId = "gen-lang-client-0485875193",
  [string]$Region = "europe-west1",
  [switch]$ConfirmInitialUserProvisioning
)

$ErrorActionPreference = "Stop"
$stage = "PREFLIGHT"
$failedStage = $null

function Get-EnvEntry($Container, [string]$Name) {
  return $Container.env | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

try {
  if (-not $ConfirmInitialUserProvisioning) {
    throw "confirmation_required"
  }

  $stage = "WEB_IMAGE"
  $service = gcloud run services describe "skyos-np-web" `
    --project $ProjectId `
    --region $Region `
    --format=json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "web_service_unavailable" }

  $revisionName = [string]$service.status.latestReadyRevisionName
  if ([string]::IsNullOrWhiteSpace($revisionName)) { throw "revision_unavailable" }

  $revision = gcloud run revisions describe $revisionName `
    --project $ProjectId `
    --region $Region `
    --format=json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "revision_unavailable" }

  $image = [string]$revision.spec.containers[0].image
  if ([string]::IsNullOrWhiteSpace($image)) { throw "image_unavailable" }

  $stage = "BOOTSTRAP_RUNTIME"
  $bootstrap = gcloud run jobs describe "skyos-np-migrator-role-bootstrap" `
    --project $ProjectId `
    --region $Region `
    --format=json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "bootstrap_job_unavailable" }

  $task = $bootstrap.spec.template.spec.template.spec
  $container = $task.containers[0]
  $serviceAccount = [string]$task.serviceAccountName

  $dbName = [string](Get-EnvEntry $container "DB_NAME").value
  $dbUser = [string](Get-EnvEntry $container "DB_USER").value
  $dbHost = [string](Get-EnvEntry $container "DB_HOST").value
  $dbPort = [string](Get-EnvEntry $container "DB_PORT").value
  $dbPasswordEntry = Get-EnvEntry $container "DB_PASSWORD"
  $dbPasswordSecret = [string]$dbPasswordEntry.valueFrom.secretKeyRef.name
  $dbPasswordVersion = [string]$dbPasswordEntry.valueFrom.secretKeyRef.key

  if ($dbName -ne "skyos" -or $dbUser -ne "skyos_migrator") {
    throw "unexpected_database_identity"
  }

  foreach ($value in @($dbHost, $dbPort, $serviceAccount, $dbPasswordSecret, $dbPasswordVersion)) {
    if ([string]::IsNullOrWhiteSpace($value)) { throw "bootstrap_runtime_incomplete" }
  }

  $stage = "JOB_CREATE"
  $payload = @'
import { PrismaPg } from '@prisma/adapter-pg';
import { getIdentitySubjectFingerprint } from '/app/database/auth/identity-audit.ts';
import { PrismaClient, UserStatus } from '/app/database/generated/client/client.js';

function safeNestedCode(error: unknown, depth = 0): string | null {
  if (depth > 4 || typeof error !== 'object' || error === null) return null;

  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string') {
    if (/^P[0-9]{4}$/.test(candidate.code)) return `PRISMA_${candidate.code}`;
    if (/^[0-9A-Z]{5}$/.test(candidate.code)) return `SQLSTATE_${candidate.code}`;
  }

  if (candidate.cause && candidate.cause !== error) {
    return safeNestedCode(candidate.cause, depth + 1);
  }

  return null;
}

function classifyP2028(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { code?: unknown; meta?: { error?: unknown } };
  if (candidate.code !== 'P2028') return null;

  const detail = typeof candidate.meta?.error === 'string' ? candidate.meta.error : '';
  if (detail.includes('Unable to start a transaction in the given time')) {
    return 'PRISMA_P2028_START_TIMEOUT';
  }
  if (detail.includes('expired transaction') || detail.includes('Transaction already closed')) {
    return 'PRISMA_P2028_EXPIRED';
  }

  return 'PRISMA_P2028';
}

function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';

  if (message === 'initial_user_provisioning_requires_empty_user_table') {
    return 'USER_TABLE_NONEMPTY';
  }

  const p2028 = classifyP2028(error);
  if (p2028) return p2028;

  const nestedCode = safeNestedCode(error);
  if (nestedCode) return nestedCode;

  if (error instanceof Error) {
    switch (error.name) {
      case 'PrismaClientInitializationError': return 'PRISMA_INITIALIZATION';
      case 'PrismaClientKnownRequestError': return 'PRISMA_KNOWN_REQUEST';
      case 'PrismaClientUnknownRequestError': return 'PRISMA_UNKNOWN_REQUEST';
      case 'PrismaClientValidationError': return 'PRISMA_VALIDATION';
      case 'DriverAdapterError': return 'DRIVER_ADAPTER';
      case 'AggregateError': return 'AGGREGATE_ERROR';
      case 'TypeError': return 'TYPE_ERROR';
      case 'SyntaxError': return 'SYNTAX_ERROR';
    }
  }

  return 'UNCLASSIFIED';
}

async function main() {
  let step = 'CONFIG';

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('invalid_provisioning_job_configuration');

    step = 'PRISMA_INIT';
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

    try {
      step = 'PROVISION';
      await prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('skyos:initial-user-provisioning'))`;

          const totalUsers = await transaction.user.count();
          if (totalUsers !== 0) {
            throw new Error('initial_user_provisioning_requires_empty_user_table');
          }

          const user = await transaction.user.create({
            data: { status: UserStatus.ACTIVE },
            select: { id: true },
          });

          await transaction.identityAuditEvent.create({
            data: {
              action: 'user.provisioned',
              provider: 'google',
              subjectFingerprint: getIdentitySubjectFingerprint(null),
              targetUserId: user.id,
              metadata: { source: 'initial_operator_bootstrap' },
            },
          });
        },
        {
          maxWait: 30_000,
          timeout: 30_000,
        },
      );

      step = 'PASS';
      console.log('Initial SkyOS user provisioning job: PASS');
    } finally {
      step = step === 'PASS' ? 'DISCONNECT_AFTER_PASS' : `DISCONNECT_AFTER_${step}`;
      await prisma.$disconnect();
    }
  } catch (error: unknown) {
    console.error(`Initial SkyOS user provisioning job: FAIL_STEP=${step}`);
    console.error(`Initial SkyOS user provisioning job: FAIL_CODE=${classifyFailure(error)}`);
    process.exitCode = 1;
  }
}

void main();
'@

  $payloadB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  $jobName = "skyos-np-first-user-provision-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $network = "projects/$ProjectId/global/networks/skyos-np"
  $subnet = "projects/$ProjectId/regions/$Region/subnetworks/skyos-np-runtime"
  $shellScript = 'set -eu; export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"; export NODE_PATH="/app/node_modules"; cd /app; printf %s "$SKYOS_PROVISIONER_PAYLOAD_B64" | base64 -d > /tmp/skyos-initial-user-provisioner.ts; exec /app/node_modules/.bin/tsx /tmp/skyos-initial-user-provisioner.ts'

  gcloud run jobs create $jobName `
    --project $ProjectId `
    --region $Region `
    --image $image `
    --service-account $serviceAccount `
    --network $network `
    --subnet $subnet `
    --vpc-egress private-ranges-only `
    --tasks 1 `
    --parallelism 1 `
    --max-retries 0 `
    --task-timeout 10m `
    --set-env-vars "DB_NAME=$dbName,DB_USER=$dbUser,DB_HOST=$dbHost,DB_PORT=$dbPort,SKYOS_PROVISIONER_PAYLOAD_B64=$payloadB64" `
    --set-secrets "DB_PASSWORD=$dbPasswordSecret`:$dbPasswordVersion" `
    --command /bin/sh `
    --args "-c,$shellScript" `
    --quiet

  if ($LASTEXITCODE -ne 0) { throw "job_create_failed" }

  $stage = "JOB_EXECUTE"
  gcloud run jobs execute $jobName `
    --project $ProjectId `
    --region $Region `
    --wait `
    --quiet

  if ($LASTEXITCODE -ne 0) { throw "job_execute_failed" }

  Write-Output "Initial SkyOS user provisioning: PASS"
}
catch {
  $failedStage = $stage
}

if ($failedStage) {
  Write-Output "Initial SkyOS user provisioning: FAIL"
  Write-Output "FAILED_STAGE=$failedStage"
  exit 1
}
