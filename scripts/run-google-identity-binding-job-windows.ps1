param(
  [string]$ProjectId = "gen-lang-client-0485875193",
  [string]$Region = "europe-west1",
  [switch]$ConfirmCurrentGoogleAccount
)

$ErrorActionPreference = "Stop"
$stage = "PREFLIGHT"
$requestVersion = $null
$requestSecret = "skyos-np-google-binding-request"

function Fail([string]$Stage) {
  Write-Error "Google identity binding: FAIL"
  Write-Output "FAILED_STAGE=$Stage"
  exit 1
}

function Get-EnvEntry($Container, [string]$Name) {
  return $Container.env | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

function Decode-JwtPayload([string]$Token) {
  $parts = $Token.Split('.')
  if ($parts.Count -ne 3) { throw "invalid_identity_token" }

  $payload = $parts[1].Replace('-', '+').Replace('_', '/')
  switch ($payload.Length % 4) {
    2 { $payload += '==' }
    3 { $payload += '=' }
    1 { throw "invalid_identity_token" }
  }

  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
  return $json | ConvertFrom-Json
}

try {
  if (-not $ConfirmCurrentGoogleAccount) {
    throw "confirmation_required"
  }

  $stage = "IDENTITY_TOKEN"
  $token = gcloud auth print-identity-token 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw "identity_token_unavailable"
  }

  $jwt = Decode-JwtPayload $token
  $googleSubject = [string]$jwt.sub
  $token = $null
  $jwt = $null

  if ([string]::IsNullOrWhiteSpace($googleSubject) -or $googleSubject.Length -gt 512) {
    throw "invalid_google_subject"
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

  $stage = "REQUEST_SECRET"
  gcloud secrets describe $requestSecret --project $ProjectId --format="value(name)" *> $null
  if ($LASTEXITCODE -ne 0) {
    gcloud secrets create $requestSecret `
      --project $ProjectId `
      --replication-policy=user-managed `
      --locations=$Region `
      --labels=application=skyos,environment=nonprod,component=identity-binding `
      --quiet *> $null
    if ($LASTEXITCODE -ne 0) { throw "request_secret_create_failed" }
  }

  gcloud secrets add-iam-policy-binding $requestSecret `
    --project $ProjectId `
    --member="serviceAccount:$serviceAccount" `
    --role="roles/secretmanager.secretAccessor" `
    --quiet *> $null
  if ($LASTEXITCODE -ne 0) { throw "request_secret_iam_failed" }

  $stage = "REQUEST_VERSION"
  $requestJson = @{ googleSubject = $googleSubject } | ConvertTo-Json -Compress
  $versionJson = $requestJson | gcloud secrets versions add $requestSecret `
    --project $ProjectId `
    --data-file=- `
    --format=json
  $requestJson = $null
  $googleSubject = $null

  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($versionJson)) {
    throw "request_version_create_failed"
  }

  $versionObject = $versionJson | ConvertFrom-Json
  $requestVersion = ([string]$versionObject.name).Split('/')[-1]
  if ($requestVersion -notmatch '^[1-9][0-9]*$') {
    throw "request_version_invalid"
  }

  $stage = "JOB_CREATE"
  $payload = @'
import { PrismaPg } from '@prisma/adapter-pg';
import { bindGoogleIdentity } from '/app/database/auth/google-identity.ts';
import { PrismaClient, UserStatus } from '/app/database/generated/client/client.js';

async function main() {
  const requestRaw = process.env.SKYOS_GOOGLE_BINDING_REQUEST;
  const databaseUrl = process.env.DATABASE_URL;
  if (!requestRaw || !databaseUrl) throw new Error('invalid_binding_job_configuration');

  const request = JSON.parse(requestRaw);
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
'@

  $payloadB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
  $jobName = "skyos-np-google-bind-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss")
  $network = "projects/$ProjectId/global/networks/skyos-np"
  $subnet = "projects/$ProjectId/regions/$Region/subnetworks/skyos-np-runtime"
  $shellScript = 'set -eu; export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"; printf %s "$SKYOS_BINDER_PAYLOAD_B64" | base64 -d > /tmp/skyos-google-binder.ts; exec /app/node_modules/.bin/tsx /tmp/skyos-google-binder.ts'

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
    --set-env-vars "DB_NAME=$dbName,DB_USER=$dbUser,DB_HOST=$dbHost,DB_PORT=$dbPort,SKYOS_BINDER_PAYLOAD_B64=$payloadB64" `
    --set-secrets "DB_PASSWORD=$dbPasswordSecret`:$dbPasswordVersion,SKYOS_GOOGLE_BINDING_REQUEST=$requestSecret`:$requestVersion" `
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

  Write-Output "Google identity binding: PASS"
}
catch {
  Fail $stage
}
finally {
  if ($requestVersion -and $requestVersion -match '^[1-9][0-9]*$') {
    gcloud secrets versions destroy $requestVersion `
      --secret $requestSecret `
      --project $ProjectId `
      --quiet *> $null
  }
}
