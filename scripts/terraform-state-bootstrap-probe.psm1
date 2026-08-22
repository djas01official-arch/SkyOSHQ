Set-StrictMode -Version Latest

function Join-DescribeOutput {
  param([AllowEmptyCollection()][object[]]$CapturedOutput)

  return (($CapturedOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine).Trim()
}

function Resolve-TerraformStateBucketDescription {
  param(
    [Parameter(Mandatory)][int]$ExitCode,
    [AllowEmptyCollection()][object[]]$CapturedOutput
  )

  $diagnostic = Join-DescribeOutput -CapturedOutput $CapturedOutput

  if ($ExitCode -eq 0) {
    try {
      if ([string]::IsNullOrWhiteSpace($diagnostic)) {
        throw 'Missing bucket description output.'
      }
      return ($diagnostic | ConvertFrom-Json -ErrorAction Stop)
    } catch {
      throw 'The reviewed Terraform state bucket description was invalid.'
    }
  }

  $hasHttp404 = $diagnostic -match '(?i)\b404\b'
  $mentionsBucketOrStorage = $diagnostic -match '(?i)\b(bucket|storage)\b'
  $isGcloudBucketDescribe = $diagnostic -match '(?i)gcloud\.storage\.buckets\.describe'
  $isBucketNotFound = $isGcloudBucketDescribe -and $hasHttp404 -and $mentionsBucketOrStorage

  if ($isBucketNotFound) {
    return $null
  }

  throw 'Unable to determine whether the reviewed Terraform state bucket exists.'
}

Export-ModuleMember -Function Resolve-TerraformStateBucketDescription
