[CmdletBinding()]
param(
    [string]$EnvFile = ".env",
    [string]$ManifestPath = "security/secrets-recovery.manifest.json",
    [string]$Recipient = $env:SKYOS_RECOVERY_AGE_RECIPIENT,
    [string]$OutputDirectory = ".skyos/recovery/encrypted"
)

$ErrorActionPreference = "Stop"

$age = Get-Command age -ErrorAction SilentlyContinue
if (-not $age) {
    throw "age was not found on PATH. Install a current version of age before creating a recovery bundle."
}
if ([string]::IsNullOrWhiteSpace($Recipient)) {
    throw "No recovery recipient was provided. Set SKYOS_RECOVERY_AGE_RECIPIENT to the public age recipient."
}
if (-not (Test-Path -LiteralPath $EnvFile)) {
    throw "Environment file '$EnvFile' was not found."
}
if (-not (Test-Path -LiteralPath $ManifestPath)) {
    throw "Recovery manifest '$ManifestPath' was not found."
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
if ($manifest.bundleFormat -ne "skyos-secrets-recovery-v1") {
    throw "Unsupported recovery manifest bundle format '$($manifest.bundleFormat)'."
}

$envValues = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith("#")) {
        continue
    }

    if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
        continue
    }

    $name = $Matches[1]
    $value = $Matches[2]
    if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            $value = $value.Substring(1, $value.Length - 2)
        }
    }
    $envValues[$name] = $value
}

$selected = [ordered]@{}
$missing = New-Object System.Collections.Generic.List[string]
foreach ($secret in $manifest.secrets) {
    if (-not $secret.includeInLocalEnvBundle -or [string]::IsNullOrWhiteSpace($secret.environmentVariable)) {
        continue
    }

    $name = [string]$secret.environmentVariable
    if ($envValues.ContainsKey($name) -and -not [string]::IsNullOrWhiteSpace([string]$envValues[$name])) {
        $selected[$name] = [string]$envValues[$name]
    }
    else {
        $missing.Add($name)
    }
}

if ($selected.Count -eq 0) {
    throw "None of the allowlisted recovery secrets were present. Refusing to create an empty bundle."
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssZ")
$outputPath = Join-Path $OutputDirectory "skyos-secrets-recovery-$timestamp.age"
$checksumPath = "$outputPath.sha256"

$payload = [ordered]@{
    format = "skyos-secrets-recovery-v1"
    createdAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    source = "local-env"
    manifestSchemaVersion = $manifest.schemaVersion
    secretNames = @($selected.Keys)
    secrets = $selected
} | ConvertTo-Json -Depth 8 -Compress

try {
    $payload | & $age.Source --encrypt --armor --recipient $Recipient --output $outputPath
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $outputPath)) {
        throw "age encryption failed."
    }

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        $checksumPath,
        "$hash  $([System.IO.Path]::GetFileName($outputPath))`n",
        [System.Text.UTF8Encoding]::new($false)
    )

    Write-Host "Encrypted SkyOS recovery bundle created: $outputPath"
    Write-Host "SHA-256 file: $checksumPath"
    Write-Host "Included secret names: $($selected.Keys -join ', ')"
    if ($missing.Count -gt 0) {
        Write-Host "Allowlisted names not present in the source env: $($missing -join ', ')"
    }
    Write-Warning "Upload only the .age file (and optionally its .sha256 file) to SkyOS Secret Recovery. Never upload the private age identity."
}
finally {
    $payload = $null
    $selected.Clear()
    $envValues.Clear()
}
