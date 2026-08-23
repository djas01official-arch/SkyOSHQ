[CmdletBinding()]
param(
    [string]$KeyDirectory = (Join-Path $HOME ".skyos-recovery-private"),
    [string]$IdentityFileName = "skyos-recovery.agekey",
    [switch]$Classic
)

$ErrorActionPreference = "Stop"

$ageKeygen = Get-Command age-keygen -ErrorAction SilentlyContinue
if (-not $ageKeygen) {
    throw "age-keygen was not found on PATH. Install a current version of age before initializing recovery keys."
}

New-Item -ItemType Directory -Path $KeyDirectory -Force | Out-Null
$identityPath = Join-Path $KeyDirectory $IdentityFileName

if (Test-Path -LiteralPath $identityPath) {
    throw "Recovery identity already exists at '$identityPath'. Refusing to overwrite it."
}

$arguments = @()
if (-not $Classic) {
    $arguments += "-pq"
}
$arguments += @("-o", $identityPath)

& $ageKeygen.Source @arguments
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $identityPath)) {
    throw "age-keygen failed. No recovery identity was accepted."
}

$recipient = (& $ageKeygen.Source -y $identityPath | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($recipient)) {
    throw "The recovery identity was created, but its public recipient could not be derived."
}

Write-Host ""
Write-Host "SkyOS recovery identity created outside the repository."
Write-Host "Private identity path: $identityPath"
Write-Host ""
Write-Host "Public recipient (safe to use for encryption):"
Write-Host $recipient
Write-Host ""
Write-Warning "Do NOT upload the private identity file to GitHub, Google Drive, email, chat, or the SkyOS backup folders. Keep at least one separate offline recovery copy."
Write-Host "For the current PowerShell session you can set the public recipient with:"
Write-Host '$env:SKYOS_RECOVERY_AGE_RECIPIENT="<public recipient printed above>"'
