$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'terraform-state-bootstrap-probe.psm1') -Force

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

$bucket = Resolve-TerraformStateBucketDescription -ExitCode 0 -CapturedOutput @('{"name":"skyos-state"}')
Assert-Equal -Actual $bucket.name -Expected 'skyos-state' -Message 'Valid JSON must return the bucket description.'

$missing = Resolve-TerraformStateBucketDescription -ExitCode 1 -CapturedOutput @(
  'ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket does not exist.'
)
Assert-Equal -Actual $missing -Expected $null -Message 'A bucket-specific HTTP 404 must mean absent.'

foreach ($diagnostic in @(
  'ERROR: HTTPError 403: Permission denied for storage bucket describe.',
  'ERROR: HTTPError 401: Unauthenticated request for storage bucket describe.',
  'ERROR: HTTPError 404: A non-storage resource was not found.',
  'ERROR: gcloud command failed before a bucket response.'
)) {
  Assert-Throws -Action {
    Resolve-TerraformStateBucketDescription -ExitCode 1 -CapturedOutput @($diagnostic)
  } -ExpectedMessage 'Unable to determine whether the reviewed Terraform state bucket exists.'
}

Assert-Throws -Action {
  Resolve-TerraformStateBucketDescription -ExitCode 0 -CapturedOutput @('{not-json}')
} -ExpectedMessage 'The reviewed Terraform state bucket description was invalid.'

Write-Output 'Terraform state bucket probe tests passed.'
