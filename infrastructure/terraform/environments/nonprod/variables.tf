variable "project_id" {
  description = "Google Cloud project ID for the SkyOS non-production environment."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id must be a lowercase Google Cloud project ID between 6 and 30 characters."
  }
}

variable "knowledge_bucket_name" {
  description = "Globally unique name for the non-production private Knowledge bucket."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.knowledge_bucket_name))
    error_message = "knowledge_bucket_name must be a conservative 3-63 character lowercase GCS bucket name using letters, digits, and hyphens."
  }
}
