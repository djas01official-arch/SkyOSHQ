[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputFile,

    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,

    [string]$OutputDirectory = ".skyos/recovery/restored"
)

$ErrorActionPreference = "Stop"

$age = Get-Command age -ErrorAction SilentlyContinue
if (-not $age) {
    throw "age was not found on PATH. Install a current version of age before restoring a recovery bundle."
}
if (-not (Test-Path -LiteralPath $InputFile)) {
    throw "Encrypted recovery bundle '$InputFile' was not found."
}
if (-not (Test-Path -LiteralPath $IdentityFile)) {
    throw "Recovery identity '$IdentityFile' was not found."
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmssZ")
$outputPath = Join-Path $OutputDirectory "restored-secrets-$timestamp.json"

$plaintext = (& $age.Source --decrypt --identity $IdentityFile $InputFile | Out-String)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($plaintext)) {
    $plaintext = $null
    throw "age decryption failed."
}

try {
    $bundle = $plaintext | ConvertFrom-Json
    if ($bundle.format -ne "skyos-secrets-recovery-v1") {
        throw "The decrypted file is not a supported SkyOS recovery bundle."
    }

    [System.IO.File]::WriteAllText(
        $outputPath,
        ($bundle | ConvertTo-Json -Depth 8),
        [System.Text.UTF8Encoding]::new($false)
    )

    $secretNames = @($bundle.secretNames)
    Write-Host "Recovery bundle decrypted to local ignored path: $outputPath"
    Write-Host "Recovered secret names: $($secretNames -join ', ')"
    Write-Warning "The restored JSON contains plaintext secrets. Keep it local, use it only for recovery, rotate credentials when the recovery strategy requires it, and delete the restored file when finished."
}
finally {
    $plaintext = $null
    $bundle = $null
}
