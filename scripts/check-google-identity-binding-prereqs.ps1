param(
  [string]$ProjectId = "gen-lang-client-0485875193",
  [string]$Region = "europe-west1"
)

$ErrorActionPreference = "Stop"

function Write-Result([string]$Name, [bool]$Ok) {
  if ($Ok) { Write-Output "$Name=OK" } else { Write-Output "$Name=FAIL" }
}

# Active gcloud identity exists. Do not print the account identifier.
try {
  $active = @(gcloud auth list --filter="status:ACTIVE" --format="value(account)" 2>$null)
  Write-Result "ACTIVE_ACCOUNT" ($LASTEXITCODE -eq 0 -and $active.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace($active[0]))
} catch {
  Write-Result "ACTIVE_ACCOUNT" $false
}

# Verify an identity token can be minted without printing or decoding it.
try {
  $token = gcloud auth print-identity-token 2>$null
  $tokenOk = $LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($token) -and ($token.Split('.').Count -eq 3)
  Write-Result "IDENTITY_TOKEN" $tokenOk
  $token = $null
} catch {
  Write-Result "IDENTITY_TOKEN" $false
}

# Verify the deployed web service and latest ready revision are readable.
try {
  $revision = gcloud run services describe "skyos-np-web" --project $ProjectId --region $Region --format="value(status.latestReadyRevisionName)" 2>$null
  Write-Result "WEB_SERVICE" ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($revision))
} catch {
  Write-Result "WEB_SERVICE" $false
}

# Verify the trusted DB bootstrap job can be read.
try {
  $bootstrap = gcloud run jobs describe "skyos-np-migrator-role-bootstrap" --project $ProjectId --region $Region --format="value(metadata.name)" 2>$null
  Write-Result "BOOTSTRAP_JOB" ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($bootstrap))
} catch {
  Write-Result "BOOTSTRAP_JOB" $false
}

# The request secret may not exist yet; report its state without exposing contents.
try {
  $null = gcloud secrets describe "skyos-np-google-binding-request" --project $ProjectId --format="value(name)" 2>$null
  if ($LASTEXITCODE -eq 0) { Write-Output "REQUEST_SECRET=EXISTS" } else { Write-Output "REQUEST_SECRET=ABSENT_OR_DENIED" }
} catch {
  Write-Output "REQUEST_SECRET=ABSENT_OR_DENIED"
}

# Report only whether any binder job was created; never print job names or arguments.
try {
  $jobs = @(gcloud run jobs list --project $ProjectId --region $Region --filter="metadata.name~^skyos-np-google-bind-" --format="value(metadata.name)" 2>$null)
  if ($LASTEXITCODE -eq 0) {
    Write-Output ("BINDER_JOB_COUNT=" + @($jobs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count)
  } else {
    Write-Output "BINDER_JOB_COUNT=UNKNOWN"
  }
} catch {
  Write-Output "BINDER_JOB_COUNT=UNKNOWN"
}
