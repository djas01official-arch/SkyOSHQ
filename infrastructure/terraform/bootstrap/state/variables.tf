variable "project_id" {
  description = "Google Cloud project ID that owns the SkyOS non-production Terraform state bucket."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a lowercase Google Cloud project ID between 6 and 30 characters."
  }
}

variable "terraform_state_bucket_name" {
  description = "Globally unique private GCS bucket name for SkyOS Terraform state."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.terraform_state_bucket_name))
    error_message = "terraform_state_bucket_name must be a conservative 3-63 character lowercase GCS bucket name using letters, digits, and hyphens."
  }
}
