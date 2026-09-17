# SkyOS Cloud SQL disaster recovery qualification

## Purpose

This runbook qualifies backup and point-in-time recovery for the SkyOS
non-production PostgreSQL database without overwriting the source instance.

The canonical non-production database is:

- project: `gen-lang-client-0485875193`;
- region: `europe-west1`;
- source instance: `skyos-np-postgres`;
- database: `skyos`;
- PostgreSQL major version: 17; and
- connectivity: private IP only.

Task 9 is not complete merely because Terraform enables backups and PITR. A
successful recent backup, a controlled isolated recovery, logical validation,
and post-recovery reconciliation evidence are required.

## Initial engineering objectives

Until production SLOs are approved, the non-production qualification objectives
are:

- **RPO objective:** no more than 5 minutes for a PITR-qualified event;
- **RTO objective:** no more than 30 minutes from the operator starting the PITR
  command until the recovered database passes the validation gates below.

These are engineering qualification objectives, not claims about measured
performance. Record measured RPO and RTO in the qualification report after the
live exercise.

## Safety rules

1. Never run a restore or PITR against `skyos-np-postgres` as the destination.
2. PITR must create a disposable instance with a unique `skyos-np-dr-...` name.
3. Confirm the active gcloud project before every mutating command.
4. Never print `DATABASE_URL`, database passwords, or Secret Manager payloads.
5. Preserve private networking. Do not enable a public IPv4 address to simplify
   validation.
6. Do not remove deletion protection from the source instance.
7. Do not repoint the production-like web, worker, reconciliation, or migrator
   runtime at the recovered instance during qualification.
8. Delete only the disposable recovery instance after evidence is captured and
   its identity has been re-checked.

## Gate A: verify the source data-protection contract

Run read-only checks first:

```powershell
$Project = "gen-lang-client-0485875193"
$Region = "europe-west1"
$Source = "skyos-np-postgres"

$ActiveProject = (gcloud config get-value project 2>$null).Trim()
if ($ActiveProject -ne $Project) {
  throw "STOP: active project '$ActiveProject' is not '$Project'."
}

gcloud sql instances describe $Source `
  --project=$Project `
  --format="yaml(name,state,region,databaseVersion,settings.tier,settings.availabilityType,settings.deletionProtectionEnabled,settings.backupConfiguration,settings.ipConfiguration)"

gcloud sql backups list `
  --instance=$Source `
  --project=$Project `
  --limit=20 `
  --format="table(id,type,status,startTime,endTime,location)"
```

Gate A passes only when live evidence shows all of the following:

- the expected source instance is `RUNNABLE`;
- scheduled backups are enabled;
- PITR is enabled;
- transaction-log retention is seven days;
- retained backup count is eight;
- the instance remains private-IP-only;
- deletion protection remains enabled; and
- at least one recent automated backup has status `SUCCESSFUL`.

Do not infer the final item from Terraform.

## Gate B: select a safe PITR timestamp

Choose an RFC 3339 UTC timestamp inside the live recovery window. Prefer a point
at least several minutes before the command is issued so transaction logs are
settled and the restored state is easy to reason about.

Record:

- selected timestamp;
- why that timestamp is inside the retained window; and
- one durable logical marker that must exist at that point, such as the current
  Prisma migration set and stable row counts for core tables.

Do not manufacture or delete application data on the source merely to create a
marker. The recovery exercise is allowed to be entirely read-only with respect
to the source database.

## Gate C: execute isolated PITR

Use a unique target name and capture wall-clock start time before the command:

```powershell
$Project = "gen-lang-client-0485875193"
$Source = "skyos-np-postgres"
$PitrTimestamp = "<RFC3339-UTC-TIMESTAMP>"
$Target = "skyos-np-dr-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$StartedUtc = (Get-Date).ToUniversalTime()

if ($Target -eq $Source) { throw "STOP: DR target must not equal source." }
if ((gcloud config get-value project 2>$null).Trim() -ne $Project) {
  throw "STOP: wrong active project."
}

gcloud sql instances clone $Source $Target `
  --project=$Project `
  --point-in-time=$PitrTimestamp

$Target
$StartedUtc.ToString("o")
```

The clone command is the only required source-adjacent mutation in this gate. It
creates a separate Cloud SQL instance; it must not modify or replace the source.

## Gate D: wait for the recovered instance and verify isolation

Read the target until it becomes `RUNNABLE`, then capture the completion time:

```powershell
do {
  Start-Sleep -Seconds 15
  $State = gcloud sql instances describe $Target `
    --project=$Project `
    --format="value(state)"
  Write-Host "DR target state: $State"
} while ($State -ne "RUNNABLE")

$ReadyUtc = (Get-Date).ToUniversalTime()
$Rto = $ReadyUtc - $StartedUtc
Write-Host "RTO seconds: $([math]::Round($Rto.TotalSeconds, 1))"

gcloud sql instances describe $Target `
  --project=$Project `
  --format="yaml(name,state,region,databaseVersion,settings.tier,settings.availabilityType,settings.ipConfiguration,ipAddresses)"
```

Gate D fails if the target unexpectedly exposes public IPv4 or if its core
configuration does not match the intended recovery architecture.

## Gate E: logical database validation

Validate through an identity that can reach the target over the reviewed private
network. Do not make the target public for operator convenience.

Capture, at minimum:

```sql
SELECT current_database(), current_user, now();
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
SELECT migration_name, finished_at
FROM "_prisma_migrations"
ORDER BY finished_at NULLS LAST, migration_name;
SELECT count(*) AS organization_count FROM organizations;
SELECT count(*) AS workspace_count FROM workspaces;
SELECT count(*) AS background_job_count FROM background_jobs;
SELECT count(*) AS knowledge_chunk_count FROM knowledge_chunks;
```

Use the source-side read-only snapshot recorded for the selected recovery point
to judge whether recovered row counts and migrations are plausible. A PITR after
normal subsequent writes is not expected to match the source's current row
counts exactly.

Also run the repository's schema/index/vector checks against the recovered
instance from an isolated operator runtime where credentials can be supplied
without logging them:

```powershell
pnpm db:validate
pnpm db:indexes:check
pnpm db:vector:check
```

Do not store the recovered database URL in source control or the qualification
report.

## Gate F: post-restore reconciliation

A recovered database is not qualified until SkyOS recovery logic can inspect it.
Run the reconciliation code in report-only mode against the disposable target.
Do not pass `--repair-expired-leases` during DR qualification unless a separate
review explicitly authorizes that mutation.

Expected evidence:

- reconciliation process exits successfully;
- report structure is complete;
- no unexpected corruption or impossible state is reported; and
- the command remains read-only.

## RPO measurement

Measure RPO from evidence, not from the configured retention period. Record the
selected PITR timestamp and the newest application/database state confirmed in
the recovered target. The measured loss window must be less than or equal to the
5-minute engineering objective.

If there is no safe way to identify a time-correlated state marker without
mutating the source, record RPO as **not measured** rather than claiming a pass.
The PITR capability can still be proven independently, but Task 9 remains open
until the RPO gate has defensible evidence.

## RTO measurement

RTO begins immediately before the `gcloud sql instances clone` command and ends
only after:

1. the target is `RUNNABLE`;
2. private-network validation succeeds;
3. schema/vector/core logical checks succeed; and
4. reconciliation report-only succeeds.

Record both infrastructure-ready time and full application-validation time.
The latter is the Task 9 RTO measurement.

## Cleanup

Before cleanup, re-read the source and target names. Delete only the disposable
DR target:

```powershell
if ($Target -eq "skyos-np-postgres") {
  throw "STOP: refusing to delete the source instance."
}
if ($Target -notlike "skyos-np-dr-*") {
  throw "STOP: target does not match the disposable DR naming convention."
}

gcloud sql instances delete $Target --project=$Project
```

If target deletion is blocked by cloned deletion-protection settings, disable
protection on the disposable target only after re-verifying its unique name.
Never patch deletion protection on `skyos-np-postgres` as part of this exercise.

## Qualification evidence

Record these values in `docs/operations/database-dr-load-qualification-report.md`:

- source instance identity and live data-protection settings;
- successful backup IDs and timestamps;
- selected PITR timestamp;
- disposable target instance name;
- PITR operation ID;
- infrastructure-ready duration;
- full measured RTO;
- measured RPO or an explicit `NOT MEASURED`;
- logical validation results;
- reconciliation result; and
- cleanup operation/result.

Do not mark the DR half of Task 9 `PASS` until every required live gate above is
supported by captured evidence.
