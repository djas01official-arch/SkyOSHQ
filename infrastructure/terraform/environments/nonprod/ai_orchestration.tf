variable "ai_chat_mode" {
  description = "SkyOS AI chat mode shared by the web request boundary and durable worker."
  type        = string
  default     = "FAST"

  validation {
    condition     = contains(["FAST", "BALANCED", "DEEP", "CRITICAL", "AUTO"], upper(trimspace(var.ai_chat_mode)))
    error_message = "ai_chat_mode must be FAST, BALANCED, DEEP, CRITICAL, or AUTO."
  }
}

locals {
  durable_ai_chat_mode = upper(trimspace(var.ai_chat_mode))
  worker_ai_secret_env_names = toset([
    for secret_name in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] : secret_name
    if contains(keys(var.web_secret_versions), secret_name)
  ])
  durable_ai_provider_secrets_configured = local.durable_ai_chat_mode == "FAST" || alltrue([
    for secret_name in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] :
    contains(keys(var.web_secret_versions), secret_name)
  ])
}

resource "google_secret_manager_secret_iam_member" "worker_ai_runtime_accessor" {
  for_each = local.worker_ai_secret_env_names

  project   = var.project_id
  secret_id = google_secret_manager_secret.web_runtime[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workload["worker"].email}"
}
