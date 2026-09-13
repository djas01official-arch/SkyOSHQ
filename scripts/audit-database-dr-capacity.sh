#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-gen-lang-client-0485875193}"
REGION="${REGION:-europe-west1}"
INSTANCE="${INSTANCE:-skyos-np-postgres}"
WEB_SERVICE="${WEB_SERVICE:-skyos-np-web}"
WORKER_POOL="${WORKER_POOL:-skyos-np-worker}"
RECONCILIATION_JOB="${RECONCILIATION_JOB:-skyos-np-reconcile}"
MIGRATOR_JOB="${MIGRATOR_JOB:-skyos-np-migrator-role-bootstrap}"

section() {
  printf '\n=== %s ===\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'STOP: required command %q is unavailable.\n' "$1" >&2
    exit 1
  fi
}

assert_active_project() {
  local active_project
  active_project="$(gcloud config get-value project 2>/dev/null | tr -d '\r' | xargs)"
  if [[ "$active_project" != "$PROJECT" ]]; then
    printf "STOP: active gcloud project '%s' does not match expected project '%s'.\n" \
      "$active_project" "$PROJECT" >&2
    exit 1
  fi
}

require_command gcloud

section "GCLOUD IDENTITY / PROJECT"
gcloud auth list --filter=status:ACTIVE --format='table(account,status)'
assert_active_project
printf 'project: %s\n' "$PROJECT"

section "CLOUD SQL LIVE CONFIG"
gcloud sql instances describe "$INSTANCE" \
  --project="$PROJECT" \
  --format='yaml(name,state,region,databaseVersion,settings.tier,settings.edition,settings.availabilityType,settings.dataDiskType,settings.dataDiskSizeGb,settings.storageAutoResize,settings.storageAutoResizeLimit,settings.deletionProtectionEnabled,settings.backupConfiguration,settings.ipConfiguration.ipv4Enabled,settings.ipConfiguration.privateNetwork,ipAddresses.type)'

section "ACTUAL BACKUP RUNS"
gcloud sql backups list \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --limit=20 \
  --format='table(id,type,status,startTime,endTime,location)'

section "RECENT CLOUD SQL OPERATIONS"
gcloud sql operations list \
  --instance="$INSTANCE" \
  --project="$PROJECT" \
  --limit=20 \
  --format='table(name,operationType,status,startTime,endTime,error.errors.code)'

section "WEB LIVE SCALING / REVISION"
gcloud run services describe "$WEB_SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='yaml(metadata.name,metadata.generation,status.latestReadyRevisionName,spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.timeoutSeconds)'

section "WORKER POOL LIVE CONFIG"
if ! gcloud run worker-pools describe "$WORKER_POOL" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='yaml(metadata.name,metadata.generation,spec.template,status)'; then
  printf '%s\n' 'GA worker-pools command unavailable; retrying with beta read-only command.'
  gcloud beta run worker-pools describe "$WORKER_POOL" \
    --project="$PROJECT" \
    --region="$REGION" \
    --format='yaml(metadata.name,metadata.generation,spec.template,status)'
fi

section "RECONCILIATION JOB LIVE CONFIG"
gcloud run jobs describe "$RECONCILIATION_JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='yaml(metadata.name,metadata.generation,spec.template.spec.taskCount,spec.template.spec.parallelism,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.timeoutSeconds)'

section "MIGRATOR JOB LIVE CONFIG"
gcloud run jobs describe "$MIGRATOR_JOB" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format='yaml(metadata.name,metadata.generation,spec.template.spec.taskCount,spec.template.spec.parallelism,spec.template.spec.template.spec.maxRetries,spec.template.spec.template.spec.timeoutSeconds)'

section "SECRET METADATA ONLY - NO PAYLOADS"
gcloud secrets list \
  --project="$PROJECT" \
  --filter='name~skyos-np-db OR name~skyos-np-database' \
  --format='table(name,createTime)'

section "DATABASE-SIDE READ-ONLY QUERIES STILL REQUIRED"
cat <<'SQL'
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
SQL

section "READ-ONLY TASK 9 AUDIT COMPLETE"
printf '%s\n' 'This script does not access Secret Manager payloads and performs no mutations.'
