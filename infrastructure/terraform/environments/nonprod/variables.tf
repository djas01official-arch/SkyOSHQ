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

variable "migration_database_password" {
  description = "Ephemeral password for the non-production SkyOS migration database identity."
  type        = string
  sensitive   = true
  ephemeral   = true
  nullable    = false
}

variable "runtime_image" {
  description = "Immutable Artifact Registry image digest reference shared by SkyOS runtime roles."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]*-docker\\.pkg\\.dev/[a-z][a-z0-9-]{4,28}[a-z0-9]/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*@sha256:[0-9a-f]{64}$", var.runtime_image))
    error_message = "runtime_image must be an Artifact Registry image reference pinned by a lowercase sha256 digest."
  }
}
