# Task 8 qualification checklist

Task 8 remains `NOT DONE` until every gate below has captured successful evidence from the canonical repository and live non-production project. Never commit `.tfplan`, `.tfstate`, logs, access tokens, or test payloads.

## 1. Repository checks

Run from Windows PowerShell:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

pnpm install --frozen-lockfile
pnpm db:generate
pnpm test:observability
pnpm typecheck
pnpm lint
pnpm build
pnpm test:ai:provider
pnpm test:knowledge:unit
pnpm test:domain
```

Run the database-backed suites with the normal repository test database contract:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

pnpm db:test:up
try {
    pnpm db:test
} finally {
    pnpm db:down
}
```

## 2. Terraform plan and apply

This is a mutation. It reads the two existing database passwords from Secret Manager into process memory, writes a local ignored plan file for inspection, and never prints either secret. The caller must already have permission to access those secret versions.

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS\infrastructure\terraform\environments\nonprod"

try {
    $MigrationPassword = (& gcloud secrets versions access latest --secret="skyos-np-db-migrator-password" --project="gen-lang-client-0485875193") -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Migration password retrieval failed." }
    $ApplicationPassword = (& gcloud secrets versions access latest --secret="skyos-np-db-application-password" --project="gen-lang-client-0485875193") -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Application password retrieval failed." }
    $env:TF_VAR_migration_database_password = $MigrationPassword.Trim()
    $env:TF_VAR_application_database_password = $ApplicationPassword.Trim()

    terraform fmt -check
    terraform validate

    $PlanPath = Join-Path $PWD "skyos-observability.tfplan"
    if (Test-Path -LiteralPath $PlanPath) { Remove-Item -LiteralPath $PlanPath -Force }
    $PlanArguments = @("plan", "-out=$PlanPath")
    & terraform @PlanArguments
    if ($LASTEXITCODE -ne 0) { throw "Terraform plan failed." }
    & terraform show $PlanPath
    if ($LASTEXITCODE -ne 0) { throw "Terraform plan inspection failed." }
    $Confirmation = Read-Host "Type APPLY only after confirming there are no unexpected destroys or replacements"
    if ($Confirmation -cne "APPLY") { throw "Apply cancelled." }
    & terraform apply $PlanPath
    if ($LASTEXITCODE -ne 0) { throw "Terraform apply failed." }
} finally {
    $env:TF_VAR_migration_database_password = $null
    $env:TF_VAR_application_database_password = $null
    $MigrationPassword = $null
    $ApplicationPassword = $null
}
```

## 3. Deploy the immutable runtime

Use the repository's established immutable-image build/deploy procedure. Confirm `skyos-np-web`, `skyos-np-worker`, and `skyos-np-reconcile` all reference the new exact digest and emit `environment`, `service`, `revision`, and `deployment_image` fields. Do not substitute a mutable tag.

## 4. Live read-only verification and correlation

First complete one harmless durable AI or Knowledge flow and copy its orchestration UUID. Then run:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

$ProjectId = "gen-lang-client-0485875193"
$Region = "europe-west1"
$OrchestrationId = Read-Host "Completed durable orchestration UUID"

& ".\scripts\verify-task8-live.ps1" `
    -ProjectId $ProjectId `
    -Region $Region `
    -OrchestrationId $OrchestrationId
```

Evidence must show orchestration, background-job, AI-run, and terminal events joined by the orchestration/domain ID. Inspect the dashboard in Cloud Console and confirm expected widgets are valid and live Cloud SQL data is present.

## 5. Controlled alert test

This is a mutation that writes exactly one harmless structured event. It does not change runtime or application data.

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

$ProjectId = "gen-lang-client-0485875193"
& ".\scripts\test-task8-controlled-alert.ps1" -ProjectId $ProjectId
```

Capture the policy condition, incident open state, and later closed state. If no notification channel is attached, record `policy evaluation verified; notification delivery not configured`.

## 6. Convergence and Git gate

Delete the local plan after apply, then prove convergence:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS\infrastructure\terraform\environments\nonprod"

$PlanPath = Join-Path $PWD "skyos-observability.tfplan"
if (Test-Path -LiteralPath $PlanPath) {
    Remove-Item -LiteralPath $PlanPath -Force
}

try {
    $MigrationPassword = (& gcloud secrets versions access latest --secret="skyos-np-db-migrator-password" --project="gen-lang-client-0485875193") -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Migration password retrieval failed." }
    $ApplicationPassword = (& gcloud secrets versions access latest --secret="skyos-np-db-application-password" --project="gen-lang-client-0485875193") -join "`n"
    if ($LASTEXITCODE -ne 0) { throw "Application password retrieval failed." }
    $env:TF_VAR_migration_database_password = $MigrationPassword.Trim()
    $env:TF_VAR_application_database_password = $ApplicationPassword.Trim()
    & terraform plan
    if ($LASTEXITCODE -ne 0) { throw "Terraform convergence plan failed." }
} finally {
    $env:TF_VAR_migration_database_password = $null
    $env:TF_VAR_application_database_password = $null
    $MigrationPassword = $null
    $ApplicationPassword = $null
}
```

Required Terraform result: `No changes. Your infrastructure matches the configuration.`

Before commit:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

git status --short
git diff
git diff --cached
git add -- `
    apps/web/auth.ts `
    apps/web/lib/health.ts `
    apps/web/lib/health.test.ts `
    database/ai/ai-conversations.ts `
    database/ai/durable-ai-orchestration.ts `
    database/background-jobs/runtime.ts `
    database/background-jobs/reconciliation-observability.ts `
    database/background-jobs/reconciliation-observability.test.ts `
    database/knowledge/knowledge-embeddings.ts `
    database/scripts/background-worker.ts `
    database/scripts/reconcile-background-jobs.ts `
    docs/operations/incident-response.md `
    docs/operations/observability-slo.md `
    docs/operations/task8-verification.md `
    infrastructure/terraform/environments/nonprod/observability.tf `
    infrastructure/terraform/environments/nonprod/operations_dashboard.tf `
    infrastructure/terraform/environments/nonprod/outputs.tf `
    infrastructure/terraform/environments/nonprod/reconciliation_job.tf `
    infrastructure/terraform/environments/nonprod/services.tf `
    infrastructure/terraform/environments/nonprod/terraform.tfvars.example `
    infrastructure/terraform/environments/nonprod/variables.tf `
    infrastructure/terraform/environments/nonprod/web_service.tf `
    infrastructure/terraform/environments/nonprod/worker_pool.tf `
    package.json `
    scripts/test-task8-controlled-alert.ps1 `
    scripts/verify-task8-live.ps1 `
    services/ai/language-model-provider.test.ts `
    services/background-jobs/config.ts `
    services/background-jobs/worker.ts `
    services/observability/logger.ts `
    services/observability/logger.test.ts `
    services/observability/terraform-contract.test.ts

git diff --cached
git commit -m "feat(ops): add production observability and SLOs"
```

Final verification:

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\alber\ash\SkyOS"

git status --short
git status
git diff
git diff --cached
git rev-parse HEAD
git log -1 --oneline
git show --stat --oneline HEAD
git show --name-status --oneline HEAD
git log --oneline -10
```
