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

  openai_api_key_configured    = contains(keys(var.web_secret_versions), "OPENAI_API_KEY")
  anthropic_api_key_configured = contains(keys(var.web_secret_versions), "ANTHROPIC_API_KEY")

  web_anthropic_auth_configured = (
    local.anthropic_api_key_configured ||
    local.anthropic_web_wif_required_configured
  )

  worker_anthropic_auth_configured = (
    local.anthropic_api_key_configured ||
    local.anthropic_worker_wif_required_configured
  )

  web_durable_ai_provider_auth_configured = (
    local.durable_ai_chat_mode == "FAST" ||
    (
      local.openai_api_key_configured &&
      local.web_anthropic_auth_configured
    )
  )

  worker_durable_ai_provider_auth_configured = (
    local.durable_ai_chat_mode == "FAST" ||
    (
      local.openai_api_key_configured &&
      local.worker_anthropic_auth_configured
    )
  )

  worker_ai_secret_env_names = toset(compact([
    local.openai_api_key_configured ? "OPENAI_API_KEY" : "",
    local.anthropic_api_key_configured && !local.anthropic_worker_wif_any_configured ? "ANTHROPIC_API_KEY" : "",
  ]))

  durable_ai_role_env = {
    AI_BALANCED_CANDIDATE_A_PROVIDER      = "openai"
    AI_BALANCED_CANDIDATE_A_MODEL         = "gpt-5.6-terra"
    AI_BALANCED_CANDIDATE_A_MODEL_VERSION = "responses-json-schema-v1"
    AI_BALANCED_CANDIDATE_B_PROVIDER      = "anthropic"
    AI_BALANCED_CANDIDATE_B_MODEL         = "claude-sonnet-5"
    AI_BALANCED_CANDIDATE_B_MODEL_VERSION = "messages-json-schema-v1"
    AI_BALANCED_SYNTHESIZER_PROVIDER      = "gemini"
    AI_BALANCED_SYNTHESIZER_MODEL         = "gemini-3.6-flash"
    AI_BALANCED_SYNTHESIZER_MODEL_VERSION = "generate-content-json-schema-v1"

    AI_DEEP_CANDIDATE_A_PROVIDER      = "openai"
    AI_DEEP_CANDIDATE_A_MODEL         = "gpt-5.6-terra"
    AI_DEEP_CANDIDATE_A_MODEL_VERSION = "responses-json-schema-v1"
    AI_DEEP_CANDIDATE_B_PROVIDER      = "anthropic"
    AI_DEEP_CANDIDATE_B_MODEL         = "claude-sonnet-5"
    AI_DEEP_CANDIDATE_B_MODEL_VERSION = "messages-json-schema-v1"
    AI_DEEP_CANDIDATE_C_PROVIDER      = "gemini"
    AI_DEEP_CANDIDATE_C_MODEL         = "gemini-3.6-flash"
    AI_DEEP_CANDIDATE_C_MODEL_VERSION = "generate-content-json-schema-v1"
    AI_DEEP_CRITIC_PROVIDER           = "anthropic"
    AI_DEEP_CRITIC_MODEL              = "claude-sonnet-4-6"
    AI_DEEP_CRITIC_MODEL_VERSION      = "messages-json-schema-v1"
    AI_DEEP_VERIFIER_PROVIDER         = "openai"
    AI_DEEP_VERIFIER_MODEL            = "gpt-5.6-terra"
    AI_DEEP_VERIFIER_MODEL_VERSION    = "responses-json-schema-v1"
    AI_DEEP_SYNTHESIZER_PROVIDER      = "gemini"
    AI_DEEP_SYNTHESIZER_MODEL         = "gemini-3.6-flash"
    AI_DEEP_SYNTHESIZER_MODEL_VERSION = "generate-content-json-schema-v1"

    AI_CRITICAL_CANDIDATE_A_PROVIDER      = "openai"
    AI_CRITICAL_CANDIDATE_A_MODEL         = "gpt-5.6-terra"
    AI_CRITICAL_CANDIDATE_A_MODEL_VERSION = "responses-json-schema-v1"
    AI_CRITICAL_CANDIDATE_B_PROVIDER      = "anthropic"
    AI_CRITICAL_CANDIDATE_B_MODEL         = "claude-sonnet-5"
    AI_CRITICAL_CANDIDATE_B_MODEL_VERSION = "messages-json-schema-v1"
    AI_CRITICAL_CANDIDATE_C_PROVIDER      = "gemini"
    AI_CRITICAL_CANDIDATE_C_MODEL         = "gemini-3.6-flash"
    AI_CRITICAL_CANDIDATE_C_MODEL_VERSION = "generate-content-json-schema-v1"
    AI_CRITICAL_CRITIC_PROVIDER           = "anthropic"
    AI_CRITICAL_CRITIC_MODEL              = "claude-sonnet-4-6"
    AI_CRITICAL_CRITIC_MODEL_VERSION      = "messages-json-schema-v1"
    AI_CRITICAL_VERIFIER_A_PROVIDER       = "openai"
    AI_CRITICAL_VERIFIER_A_MODEL          = "gpt-5.6-terra"
    AI_CRITICAL_VERIFIER_A_MODEL_VERSION  = "responses-json-schema-v1"
    AI_CRITICAL_VERIFIER_B_PROVIDER       = "anthropic"
    AI_CRITICAL_VERIFIER_B_MODEL          = "claude-sonnet-5"
    AI_CRITICAL_VERIFIER_B_MODEL_VERSION  = "messages-json-schema-v1"
    AI_CRITICAL_SYNTHESIZER_PROVIDER      = "gemini"
    AI_CRITICAL_SYNTHESIZER_MODEL         = "gemini-3.6-flash"
    AI_CRITICAL_SYNTHESIZER_MODEL_VERSION = "generate-content-json-schema-v1"
  }
}

resource "google_secret_manager_secret_iam_member" "worker_ai_runtime_accessor" {
  for_each = local.worker_ai_secret_env_names

  project   = var.project_id
  secret_id = google_secret_manager_secret.web_runtime[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workload["worker"].email}"
}
