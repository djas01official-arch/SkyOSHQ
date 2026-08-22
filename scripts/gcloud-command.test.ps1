$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'gcloud-command.psm1') -Force

function Assert-Equal {
  param([AllowNull()]$Actual, [AllowNull()]$Expected, [string]$Message)

  if ($Actual -ne $Expected) { throw $Message }
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$ExpectedMessage)

  try {
    & $Action
  } catch {
    Assert-Equal -Actual $_.Exception.Message -Expected $ExpectedMessage -Message 'Unexpected error message.'
    return
  }
  throw 'Expected the action to throw.'
}

$observedPaths = [System.Collections.Generic.List[string]]::new()
$stdoutOnlyExecutor = {
  param([string[]]$Arguments, [string]$StandardErrorPath)
  [pscustomobject]@{ ExitCode = 0; StandardOutput = @('stdout only') }
}
$stdoutOnly = Invoke-GcloudCommand -Arguments @('auth', 'list') -Executor $stdoutOnlyExecutor
Assert-Equal -Actual $stdoutOnly -Expected 'stdout only' -Message 'Successful stdout must be returned.'

$successExecutor = {
  param([string[]]$Arguments, [string]$StandardErrorPath)
  $observedPaths.Add($StandardErrorPath)
  [System.IO.File]::WriteAllText($StandardErrorPath, 'Creating gs://progress-only')
  [pscustomobject]@{ ExitCode = 0; StandardOutput = @('safe stdout') }
}

$beforeSuccessPreference = $ErrorActionPreference
$success = Invoke-GcloudCommand -Arguments @('storage', 'buckets', 'create') -Executor $successExecutor
Assert-Equal -Actual $success -Expected 'safe stdout' -Message 'Successful stdout must be returned without stderr.'
Assert-Equal -Actual $ErrorActionPreference -Expected $beforeSuccessPreference -Message 'ErrorActionPreference must be restored after success.'
if (Test-Path -LiteralPath $observedPaths[0]) { throw 'Temporary stderr artifact remained after success.' }

$stderrOnlyExecutor = {
  param([string[]]$Arguments, [string]$StandardErrorPath)
  [System.IO.File]::WriteAllText($StandardErrorPath, 'progress only')
  [pscustomobject]@{ ExitCode = 0; StandardOutput = @() }
}
$stderrOnly = Invoke-GcloudCommand -Arguments @('storage', 'buckets', 'update') -Executor $stderrOnlyExecutor
Assert-Equal -Actual $stderrOnly -Expected '' -Message 'Success with stderr only must return empty stdout.'

$failurePaths = [System.Collections.Generic.List[string]]::new()
$failureExecutor = {
  param([string[]]$Arguments, [string]$StandardErrorPath)
  $failurePaths.Add($StandardErrorPath)
  [System.IO.File]::WriteAllText($StandardErrorPath, 'permission denied')
  [pscustomobject]@{ ExitCode = 1; StandardOutput = @() }
}

$beforeFailurePreference = $ErrorActionPreference
Assert-Throws -Action {
  Invoke-GcloudCommand -Arguments @('storage', 'buckets', 'create') -Executor $failureExecutor
} -ExpectedMessage 'A gcloud command failed while validating or provisioning the reviewed Terraform state bucket.'
Assert-Equal -Actual $ErrorActionPreference -Expected $beforeFailurePreference -Message 'ErrorActionPreference must be restored after failure.'
if (Test-Path -LiteralPath $failurePaths[0]) { throw 'Temporary stderr artifact remained after failure.' }

$partialOutputFailureExecutor = {
  param([string[]]$Arguments, [string]$StandardErrorPath)
  [System.IO.File]::WriteAllText($StandardErrorPath, 'invalid argument')
  [pscustomobject]@{ ExitCode = 2; StandardOutput = @('must not be returned') }
}
Assert-Throws -Action {
  Invoke-GcloudCommand -Arguments @('projects', 'describe') -Executor $partialOutputFailureExecutor
} -ExpectedMessage 'A gcloud command failed while validating or provisioning the reviewed Terraform state bucket.'

Write-Output 'gcloud command tests passed.'
