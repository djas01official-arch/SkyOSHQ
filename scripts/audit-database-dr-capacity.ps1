[CmdletBinding()]
param(
  [string]$Project = "gen-lang-client-0485875193",
  [string]$Region = "europe-west1",
  [string]$Instance = "skyos-np-postgres",
  [string]$WebService = "skyos-np-web",
  [string]$WorkerPool = "skyos-np-worker",
  [string]$ReconciliationJob = "skyos-np-reconcile",
  [string]$MigratorJob = "skyos-np-migrator-role-bootstrap"
)

$ErrorActionPreference = "Stop"

function Write-Section([string]$Name) {
  Write-Host ""
  Write-Host "=== $Name ==="
}

function Assert-ActiveProject {
  $activeProject = (gcloud config get-value project 2>$null).Trim()
  if ($activeProject -ne $Project) {
    throw "STOP: active gcloud project '$activeProject' does not match expected project '$Project'."
  }
}

Write-Section "GCLOUD IDENTITY / PROJECT"
gcloud auth list --filter=status:ACTIVE --format="table(account,status)"
Assert-ActiveProject
Write-Host "project: $Project"

Write-Section "CLOUD SQL LIVE CONFIG"
gcloud sql instances describe $Instance `
  --project=$Project `
  --format="yaml(name,state,region,databaseVersion,settings.tier,settings.edition,settings.availabilityType,settings.dataDiskType,settings.dataDiskSizeGb,settings.storageAutoResize,settings.storageAutoResizeLimit,settings.deletionProtectionEnabled,settings.backupConfiguration,settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.privateNetwork,ipAddresses.type)"

Write-Section "ACTUAL BACKUP RUNS"
gcloud sql backups list `
  --instance=$Instance `
  --project=$Project `
  --limit=20 `
  --format="table(id,type,status,startTime,endTime,location)"

Write-Section "RECENT CLOUD SQL OPERATIONS"
gcloud sql operations list `
  --instance=$Instance `
  --project=$Project `
  --limit=20 `
  --format="table(name,operationType,status,startTime,endTime,error.errors.code)"

Write-Section "WEB LIVE SCALING / REVISION"
gcloud run services describe $WebService `
  --project=$Project `
  --region=$Region `
  --format="yaml(metadata.name,metadata.generation,status.latestReadyRevisionName,spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.timeoutSeconds)"

Write-Section "WORKER POOL LIVE CONFIG"
try {
  gcloud run worker-pools describe $WorkerPool `
    --project=$Project `
    --region=$Region `
    --format="yaml(metadata.name,metadata.generation,spec.template,status)"
}
catch {
  Write-Host "GA worker-pools command unavailable; retrying with beta read-only command."
  gcloud beta run worker-pools describe $WorkerPool `
    --project=$Project `
    --region=$Region `
    --format="yaml(metadata.name,metadata.generation,spec.template,status)"
}

Write-Section "RECONCILIATION JOB LIVE CONFIG"
gcloud run jobs describe $ReconciliationJob `
  --project=$Project `
  --region=$Region `
  --format="yaml(metadata.name,metadata.generation,spec.template.spec.taskCount,spec.template.spec.parallelism,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.timeoutSeconds)"

Write-Section "MIGRATOR JOB LIVE CONFIG"
gcloud run jobs describe $MigratorJob `
  --project=$Project `
  --region=$Region `
  --format="yaml(metadata.name,metadata.generation,spec.template.spec.taskCount,spec.template.spec.parallelism,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.timeoutSeconds)"

Write-Section "SECRET METADATA ONLY - NO PAYLOADS"
gcloud secrets list `
  --project=$Project `
  --filter="name~skyos-np-db OR name~skyos-np-database" `
  --format="table(name,createTime)"

Write-Section "DATABASE-SIDE READ-ONLY QUERIES STILL REQUIRED"
Write-Host @'
Run these from an approved private-network database session without printing the connection URL:

SELECT setting::int AS max_connections
FROM pg_settings
WHERE name = 'max_connections';

SELECT state, count(*) AS connections
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY state NULLS FIRST;

SELECT count(*) AS all_database_connections
FROM pg_stat_activity;
'@

Write-Section "READ-ONLY TASK 9 AUDIT COMPLETE"
Write-Host "This script does not access Secret Manager payloads and performs no mutations."
