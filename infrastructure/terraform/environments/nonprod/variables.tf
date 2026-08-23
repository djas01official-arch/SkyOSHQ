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

variable "enable_web_service" {
  description = "Create the SkyOS Cloud Run web service after its pinned runtime secret versions are ready."
  type        = bool
  default     = false
  nullable    = false
}

variable "web_allow_unauthenticated" {
  description = "Grant allUsers the Cloud Run invoker role for the web service. Keep false until public exposure is explicitly reviewed."
  type        = bool
  default     = false
  nullable    = false
}

variable "web_google_oauth_client_id" {
  description = "Non-secret Google OAuth client ID injected into the production web runtime."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = length(var.web_google_oauth_client_id) <= 4096
    error_message = "web_google_oauth_client_id must not exceed 4096 characters."
  }
}

variable "web_secret_versions" {
  description = "Pinned numeric Secret Manager versions exposed to the web runtime. This map contains version numbers only, never secret values."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition = alltrue([
      for name in keys(var.web_secret_versions) : contains([
        "DATABASE_URL",
        "AUTH_SECRET",
        "AUTH_GOOGLE_SECRET",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
      ], name)
    ])
    error_message = "web_secret_versions contains an unsupported runtime secret name."
  }

  validation {
    condition = alltrue([
      for version in values(var.web_secret_versions) : can(regex("^[1-9][0-9]*$", version))
    ])
    error_message = "web_secret_versions must pin each configured secret to a positive numeric Secret Manager version."
  }
}
