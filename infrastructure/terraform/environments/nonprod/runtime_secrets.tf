locals {
  web_runtime_secret_specs = {
    DATABASE_URL = {
      secret_id = "skyos-np-database-url"
    }
    AUTH_SECRET = {
      secret_id = "skyos-np-auth-secret"
    }
    AUTH_GOOGLE_SECRET = {
      secret_id = "skyos-np-auth-google-secret"
    }
    OPENAI_API_KEY = {
      secret_id = "skyos-np-openai-api-key"
    }
    ANTHROPIC_API_KEY = {
      secret_id = "skyos-np-anthropic-api-key"
    }
    GEMINI_API_KEY = {
      secret_id = "skyos-np-gemini-api-key"
    }
  }

  web_required_secret_env_names = toset([
    "DATABASE_URL",
    "AUTH_SECRET",
    "AUTH_GOOGLE_SECRET",
  ])

  web_configured_secret_env_names = toset(keys(var.web_secret_versions))
  web_active_secret_env_names     = var.enable_web_service ? local.web_configured_secret_env_names : toset([])
}

resource "google_secret_manager_secret" "web_runtime" {
  for_each = local.web_runtime_secret_specs

  project             = var.project_id
  secret_id           = each.value.secret_id
  deletion_protection = true

  labels = {
    application = "skyos"
    environment = "nonprod"
    component   = "web-runtime"
  }

  replication {
    user_managed {
      replicas {
        location = local.primary_region
      }
    }
  }

  depends_on = [google_project_service.secret_manager]
}

resource "google_secret_manager_secret_iam_member" "web_runtime_accessor" {
  for_each = local.web_active_secret_env_names

  project   = var.project_id
  secret_id = google_secret_manager_secret.web_runtime[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workload["web"].email}"
}
