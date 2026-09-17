param(
    [string]$ProjectId = "gen-lang-client-0485875193",
    [string]$ExistingTestId = ""
)

$ErrorActionPreference = "Stop"
$IsRecovery = -not [string]::IsNullOrWhiteSpace($ExistingTestId)
$TestId = if ($IsRecovery) { $ExistingTestId.Trim() } else { [guid]::NewGuid().ToString() }
$ParsedTestId = [guid]::Empty
if (-not [guid]::TryParse($TestId, [ref]$ParsedTestId)) {
    throw "ExistingTestId must be a valid UUID."
}

$AccessToken = (& gcloud auth print-access-token).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($AccessToken)) {
    throw "A valid gcloud access token is required."
}
$Headers = @{
    Authorization         = "Bearer $AccessToken"
    "Content-Type"        = "application/json"
    "x-goog-user-project" = $ProjectId
}

function Get-ResponseCollection {
    param(
        [object]$Response,
        [string]$PropertyName
    )

    if ($null -eq $Response) { return @() }
    $Property = $Response.PSObject.Properties[$PropertyName]
    if ($null -eq $Property) { return @() }
    return @($Property.Value)
}

function Get-ControlledSignals {
    $Filter = 'logName="projects/' + $ProjectId + '/logs/skyos-controlled-alert-test" AND jsonPayload.operation="observability.alert_test" AND jsonPayload.result="' + $TestId + '"'
    $ReadBody = @{
        resourceNames = @("projects/$ProjectId")
        filter        = $Filter
        orderBy       = "timestamp desc"
        pageSize      = 5
    } | ConvertTo-Json -Depth 10
    $Response = Invoke-RestMethod `
        -Method Post `
        -Uri "https://logging.googleapis.com/v2/entries:list" `
        -Headers $Headers `
        -Body $ReadBody
    return @(Get-ResponseCollection -Response $Response -PropertyName "entries")
}

if ($IsRecovery) {
    Write-Host "RECOVERY: reusing controlled observability event $TestId; no new event will be written."
    $ExistingSignals = @(Get-ControlledSignals)
    if ($ExistingSignals.Count -eq 0) {
        throw "The existing controlled event was not found in Cloud Logging."
    }
    $TimestampProperty = $ExistingSignals[0].PSObject.Properties["timestamp"]
    if ($null -eq $TimestampProperty) {
        throw "The existing controlled event has no timestamp."
    }
    $TestStartedAt = ([datetime]$TimestampProperty.Value).ToUniversalTime()
}
else {
    $TestStartedAt = (Get-Date).ToUniversalTime()
    $WriteBody = @{
        logName  = "projects/$ProjectId/logs/skyos-controlled-alert-test"
        resource = @{
            type   = "global"
            labels = @{ project_id = $ProjectId }
        }
        entries  = @(
            @{
                severity    = "NOTICE"
                jsonPayload = @{
                    environment = "nonprod"
                    service     = "operator"
                    severity    = "NOTICE"
                    operation   = "observability.alert_test"
                    status      = "TRIGGERED"
                    result      = $TestId
                }
            }
        )
    } | ConvertTo-Json -Depth 10

    Write-Host "MUTATION: emitting one non-secret controlled observability event with test id $TestId"
    Invoke-RestMethod `
        -Method Post `
        -Uri "https://logging.googleapis.com/v2/entries:write" `
        -Headers $Headers `
        -Body $WriteBody | Out-Null
}

$AlertsUri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/alerts?pageSize=100"

function Get-ControlledAlerts {
    $Response = Invoke-RestMethod -Method Get -Headers $Headers -Uri $AlertsUri
    $Alerts = @(Get-ResponseCollection -Response $Response -PropertyName "alerts")
    return @($Alerts | Where-Object {
        $PolicyProperty = $_.PSObject.Properties["policy"]
        $OpenTimeProperty = $_.PSObject.Properties["openTime"]
        if ($null -eq $PolicyProperty -or $null -eq $OpenTimeProperty) { return $false }
        $DisplayNameProperty = $PolicyProperty.Value.PSObject.Properties["displayName"]
        if ($null -eq $DisplayNameProperty) { return $false }
        return $DisplayNameProperty.Value -eq "SkyOS nonprod: controlled alert pipeline test" -and
            [datetime]$OpenTimeProperty.Value -ge $TestStartedAt.AddMinutes(-1)
    })
}

$ObservedAlert = $null
for ($Attempt = 1; $Attempt -le 20; $Attempt += 1) {
    Start-Sleep -Seconds 15
    $ObservedAlert = Get-ControlledAlerts |
        Where-Object { $_.state -eq "OPEN" -or $_.state -eq "CLOSED" } |
        Select-Object -First 1
    if ($ObservedAlert) { break }
}
if (-not $ObservedAlert) {
    throw "The controlled alert was not observed within five minutes."
}
if ($ObservedAlert.state -eq "OPEN") {
    Write-Host "The controlled alert entered OPEN state."
}
else {
    Write-Host "RECOVERY: the controlled alert is already CLOSED; its open and close timestamps preserve the lifecycle evidence."
}
$ObservedAlert | Select-Object name, state, openTime, closeTime, policy

Write-Host "READ-ONLY: confirming the exact signal reached Cloud Logging"
$Signals = @(Get-ControlledSignals)
if ($Signals.Count -eq 0) { throw "Controlled event readback failed." }
$Signals | Select-Object timestamp, severity, logName, jsonPayload

$ClosedAlert = if ($ObservedAlert.state -eq "CLOSED") { $ObservedAlert } else { $null }
if (-not $ClosedAlert) {
    for ($Attempt = 1; $Attempt -le 160; $Attempt += 1) {
        Start-Sleep -Seconds 15
        $ClosedAlert = Get-ControlledAlerts |
            Where-Object { $_.name -eq $ObservedAlert.name -and $_.state -eq "CLOSED" } |
            Select-Object -First 1
        if ($ClosedAlert) { break }
    }
}
if (-not $ClosedAlert) {
    throw "The controlled alert did not enter CLOSED state within forty minutes after opening."
}
$ClosedAlert | Select-Object name, state, openTime, closeTime, policy

Write-Host "Controlled alert evaluation verified end to end: signal -> OPEN -> CLOSED."
Write-Host "Notification delivery is not claimed unless a reviewed notification channel is attached and observed."
