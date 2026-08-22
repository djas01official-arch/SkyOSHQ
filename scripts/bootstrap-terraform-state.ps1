[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId,

  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')]
  [string]$StateBucketName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'terraform-state-bootstrap-probe.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'gcloud-command.psm1') -Force

$primaryRegion = 'europe-west1'
$expectedLabels = @{ application = 'skyos'; environment = 'nonprod'; component = 'terraform-state' }

function Get-ObjectProperty {
  param([AllowNull()][object]$Object, [Parameter(Mandatory)][string]$Name)

  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Invoke-Gcloud {
  param([Parameter(Mandatory)][string[]]$Arguments)

  return Invoke-GcloudCommand -Arguments $Arguments
}

function Get-BucketDescription {
  param([Parameter(Mandatory)][string]$BucketName)

  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell invokes gcloud through gcloud.ps1. Keep native stderr
    # non-terminating only for this expected-existence probe and capture it for
    # strict result classification below.
    $ErrorActionPreference = 'Continue'
    $output = & gcloud storage buckets describe "gs://$BucketName" --format=json 2>&1
    $exitCode = $LASTEXITCODE
  } catch {
    throw 'Unable to determine whether the reviewed Terraform state bucket exists.'
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  return Resolve-TerraformStateBucketDescription -ExitCode $exitCode -CapturedOutput @($output)
}

function Assert-ExpectedBucket {
  param(
    [Parameter(Mandatory)][object]$Bucket,
    [Parameter(Mandatory)][string]$ExpectedProjectNumber
  )

  $location = [string](Get-ObjectProperty $Bucket 'location')
  $storageClass = [string](Get-ObjectProperty $Bucket 'storageClass')
  $projectNumber = [string](Get-ObjectProperty $Bucket 'projectNumber')
  $iamConfiguration = Get-ObjectProperty $Bucket 'iamConfiguration'
  $ubla = Get-ObjectProperty (Get-ObjectProperty $iamConfiguration 'uniformBucketLevelAccess') 'enabled'
  $pap = [string](Get-ObjectProperty $iamConfiguration 'publicAccessPrevention')
  $versioning = Get-ObjectProperty (Get-ObjectProperty $Bucket 'versioning') 'enabled'
  $softDelete = Get-ObjectProperty (Get-ObjectProperty $Bucket 'softDeletePolicy') 'retentionDurationSeconds'
  $labels = Get-ObjectProperty $Bucket 'labels'

  if ($projectNumber -ne $ExpectedProjectNumber -or
      $location.ToUpperInvariant() -ne $primaryRegion.ToUpperInvariant() -or
      $storageClass.ToUpperInvariant() -ne 'STANDARD' -or
      $ubla -ne $true -or
      $pap.ToLowerInvariant() -ne 'enforced' -or
      $versioning -ne $true -or
      [string]$softDelete -notin @('604800', '604800s')) {
    throw 'The existing bucket does not match the required SkyOS Terraform-state ownership or hardening contract.'
  }

  foreach ($label in $expectedLabels.GetEnumerator()) {
    if ((Get-ObjectProperty $labels $label.Key) -ne $label.Value) {
      throw 'The existing bucket does not match the required SkyOS Terraform-state labels.'
    }
  }
}

if ($WhatIfPreference) {
  Write-Output "WhatIf: validate project '$ProjectId' and state bucket '$StateBucketName'."
  Write-Output "WhatIf: use fixed region '$primaryRegion'; no gcloud command will run."
  Write-Output "WhatIf: if absent, create gs://$StateBucketName with Standard storage, UBLA, PAP, and seven-day soft delete."
  Write-Output "WhatIf: enable Object Versioning and expected non-sensitive labels, then verify the bucket before Terraform import."
  return
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw 'gcloud is required for the approved bootstrap operation.'
}

$activeAccount = Invoke-Gcloud @('auth', 'list', '--filter=status:ACTIVE', '--format=value(account)')
if ([string]::IsNullOrWhiteSpace(($activeAccount -join '').Trim())) {
  throw 'An authenticated active gcloud account is required for the approved bootstrap operation.'
}

$project = (Invoke-Gcloud @('projects', 'describe', $ProjectId, '--format=json') | ConvertFrom-Json)
if ([string](Get-ObjectProperty $project 'lifecycleState') -ne 'ACTIVE') {
  throw 'The requested Google Cloud project is not active.'
}
$projectNumber = [string](Get-ObjectProperty $project 'projectNumber')

foreach ($service in @('storage.googleapis.com', 'iam.googleapis.com')) {
  $enabled = Invoke-Gcloud @('services', 'list', '--enabled', "--project=$ProjectId", "--filter=config.name=$service", '--format=value(config.name)')
  if (($enabled -join '').Trim() -ne $service) {
    throw "Required Google Cloud API '$service' must be enabled by an authorized operator before bootstrap."
  }
}

$bucket = Get-BucketDescription -BucketName $StateBucketName
if ($null -ne $bucket) {
  Assert-ExpectedBucket -Bucket $bucket -ExpectedProjectNumber $projectNumber
  Write-Output "Existing compliant state bucket gs://$StateBucketName was verified; no bucket mutation was performed."
  return
}

if (-not $PSCmdlet.ShouldProcess("gs://$StateBucketName", 'Create the reviewed SkyOS Terraform state bucket')) {
  return
}

Invoke-Gcloud @(
  'storage', 'buckets', 'create', "gs://$StateBucketName", "--project=$ProjectId",
  "--location=$primaryRegion", '--default-storage-class=STANDARD',
  '--uniform-bucket-level-access', '--public-access-prevention', '--soft-delete-duration=7d'
) | Out-Null
Invoke-Gcloud @(
  'storage', 'buckets', 'update', "gs://$StateBucketName", "--project=$ProjectId", '--versioning',
  '--update-labels=application=skyos,environment=nonprod,component=terraform-state'
) | Out-Null

$bucket = Get-BucketDescription -BucketName $StateBucketName
if ($null -eq $bucket) {
  throw 'The created state bucket could not be verified. Stop before Terraform initialization.'
}
Assert-ExpectedBucket -Bucket $bucket -ExpectedProjectNumber $projectNumber
Write-Output "Created and verified gs://$StateBucketName. Initialize the remote backend and import the bucket before any Terraform plan."
