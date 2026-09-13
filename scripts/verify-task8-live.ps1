param(
    [string]$ProjectId = "gen-lang-client-0485875193",
    [string]$Region = "europe-west1",
    [string]$OrchestrationId = ""
)

$ErrorActionPreference = "Stop"
$AccessToken = (& gcloud auth print-access-token).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($AccessToken)) {
    throw "A valid gcloud access token is required."
}
$Headers = @{ Authorization = "Bearer $AccessToken" }

Write-Host "READ-ONLY: dashboard, metrics, policies, runtimes, and recent structured logs"

$DashboardResponse = Invoke-RestMethod `
    -Headers $Headers `
    -Uri "https://monitoring.googleapis.com/v1/projects/$ProjectId/dashboards"
$DashboardResponse.dashboards |
    Where-Object { $_.displayName -eq "SkyOS nonprod operations" } |
    Select-Object name, displayName

$MetricResponse = Invoke-RestMethod `
    -Headers $Headers `
    -Uri "https://logging.googleapis.com/v2/projects/$ProjectId/metrics"
$MetricResponse.metrics |
    Where-Object { $_.name -like "skyos_*" } |
    Sort-Object name |
    Select-Object name, description

$PolicyResponse = Invoke-RestMethod `
    -Headers $Headers `
    -Uri "https://monitoring.googleapis.com/v3/projects/$ProjectId/alertPolicies"
$PolicyResponse.alertPolicies |
    Where-Object { $_.displayName -like "SkyOS nonprod:*" } |
    Sort-Object displayName |
    Select-Object name, displayName, enabled, notificationChannels

& gcloud run services describe skyos-np-web `
    --project=$ProjectId `
    --region=$Region `
    --format="table(metadata.name,status.latestReadyRevisionName,status.url)"
if ($LASTEXITCODE -ne 0) { throw "Cloud Run web inspection failed." }

& gcloud beta run worker-pools describe skyos-np-worker `
    --project=$ProjectId `
    --region=$Region `
    --format="table(metadata.name,status.latestReadyRevision)"
if ($LASTEXITCODE -ne 0) { throw "Cloud Run worker-pool inspection failed." }

& gcloud run jobs describe skyos-np-reconcile `
    --project=$ProjectId `
    --region=$Region `
    --format="table(metadata.name,spec.template.template.timeoutSeconds,status.latestCreatedExecution.name)"
if ($LASTEXITCODE -ne 0) { throw "Cloud Run reconciliation inspection failed." }

& gcloud logging read `
    'jsonPayload.environment="nonprod" AND jsonPayload.operation:*' `
    --project=$ProjectId `
    --freshness=24h `
    --limit=50 `
    --format="table(timestamp,jsonPayload.service,jsonPayload.operation,jsonPayload.status,jsonPayload.error_category)"
if ($LASTEXITCODE -ne 0) { throw "Structured log inspection failed." }

$End = (Get-Date).ToUniversalTime()
$Start = $End.AddHours(-1)
$MetricFilter = [uri]::EscapeDataString('metric.type="cloudsql.googleapis.com/database/cpu/utilization"')
$StartValue = [uri]::EscapeDataString($Start.ToString("o"))
$EndValue = [uri]::EscapeDataString($End.ToString("o"))
$TimeSeriesUri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/timeSeries?filter=$MetricFilter&interval.startTime=$StartValue&interval.endTime=$EndValue&pageSize=5"
$SqlSeries = Invoke-RestMethod -Headers $Headers -Uri $TimeSeriesUri
if (-not $SqlSeries.timeSeries) { throw "No live Cloud SQL CPU time series was returned for the last hour." }
$SqlSeries.timeSeries | Select-Object -First 5 metric, resource, points

if (-not [string]::IsNullOrWhiteSpace($OrchestrationId)) {
    if ($OrchestrationId -notmatch '^[0-9A-Fa-f-]{36}$') {
        throw "OrchestrationId must be a UUID."
    }
    $CorrelationFilter = 'jsonPayload.orchestration_id="' + $OrchestrationId + '" OR jsonPayload.domain_job_id="' + $OrchestrationId + '"'
    & gcloud logging read $CorrelationFilter `
        --project=$ProjectId `
        --freshness=24h `
        --limit=100 `
        --format="table(timestamp,jsonPayload.service,jsonPayload.operation,jsonPayload.orchestration_id,jsonPayload.background_job_id,jsonPayload.run_id,jsonPayload.status)"
    if ($LASTEXITCODE -ne 0) { throw "Correlation query failed." }
}

Write-Host "Read-only verification completed. Inspect the dashboard visually for invalid or empty expected panels."
