Set-StrictMode -Version Latest

function Join-StandardOutput {
  param([AllowEmptyCollection()][object[]]$StandardOutput)

  return (($StandardOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
}

function Invoke-GcloudCommand {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [scriptblock]$Executor = {
      param([string[]]$CommandArguments, [string]$StandardErrorPath)

      $standardOutput = & gcloud @CommandArguments 2> $StandardErrorPath
      return [pscustomobject]@{
        ExitCode       = $LASTEXITCODE
        StandardOutput = @($standardOutput)
      }
    }
  )

  try {
    $standardErrorPath = [System.IO.Path]::GetTempFileName()
  } catch {
    throw 'A gcloud command failed while validating or provisioning the reviewed Terraform state bucket.'
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $result = $null
  $executionFailed = $false
  $cleanupFailed = $false

  try {
    # Windows PowerShell can resolve gcloud to gcloud.ps1. Native stderr must be
    # non-terminating here so that the process exit code remains authoritative.
    $ErrorActionPreference = 'Continue'
    $result = & $Executor $Arguments $standardErrorPath
  } catch {
    $executionFailed = $true
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    try {
      Remove-Item -LiteralPath $standardErrorPath -Force -ErrorAction Stop
    } catch {
      $cleanupFailed = $true
    }
  }

  if ($executionFailed -or $cleanupFailed -or $null -eq $result -or $result.ExitCode -ne 0) {
    throw 'A gcloud command failed while validating or provisioning the reviewed Terraform state bucket.'
  }

  return (Join-StandardOutput -StandardOutput @($result.StandardOutput))
}

Export-ModuleMember -Function Invoke-GcloudCommand
