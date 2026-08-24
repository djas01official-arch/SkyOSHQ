data "google_project" "current" {
  project_id = var.project_id
}
locals {
  web_auth_url = "https://skyos-np-web-${data.google_project.current.number}.${local.primary_region}.run.app"
  web_required_secrets_configured = alltrue([
    for secret_name in local.web_required_secret_env_names :
    contains(local.web_configured_secret_env_names, secret_name)
  ])
}

resource "google_cloud_run_v2_service" "web" {
  count = var.enable_web_service ? 1 : 0

  project             = var.project_id
  name                = "skyos-np-web"
  location            = local.primary_region
  deletion_protection = true
  ingress             = "INGRESS_TRAFFIC_ALL"
  launch_stage        = "GA"

  labels = merge(local.common_labels, {
    component = "web"
  })

  template {
    service_account       = google_service_account.workload["web"].email
    execution_environment = "EXECUTION_ENVIRONMENT_GEN2"
    timeout               = "300s"

    containers {
      image = var.runtime_image

      env {
        name  = "AUTH_URL"
        value = local.web_auth_url
      }

      env {
        name  = "AUTH_GOOGLE_ID"
        value = var.web_google_oauth_client_id
      }

      env {
        name  = "KNOWLEDGE_STORAGE_PROVIDER"
        value = "gcs"
      }

      env {
        name  = "KNOWLEDGE_GCS_BUCKET"
        value = google_storage_bucket.knowledge.name
      }

      env {
        name  = "BACKGROUND_JOB_MODE"
        value = "synchronous"
      }

      env {
        name  = "AI_PROVIDER"
        value = "local"
      }

      env {
        name  = "EMBEDDING_PROVIDER"
        value = "local"
      }

      dynamic "env" {
        for_each = var.web_secret_versions

        content {
          name = env.key

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.web_runtime[env.key].secret_id
              version = env.value
            }
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"

      network_interfaces {
        network    = google_compute_network.skyos.id
        subnetwork = google_compute_subnetwork.runtime.id
      }
    }
  }

  lifecycle {
    precondition {
      condition     = local.web_required_secrets_configured
      error_message = "Enabling the web service requires pinned DATABASE_URL, AUTH_SECRET, and AUTH_GOOGLE_SECRET Secret Manager versions."
    }

    precondition {
      condition     = trimspace(var.web_google_oauth_client_id) != ""
      error_message = "Enabling the web service requires web_google_oauth_client_id."
    }
  }

  depends_on = [
    google_project_service.cloud_run,
    google_secret_manager_secret_iam_member.web_runtime_accessor,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "web_public_invoker" {
  count = var.enable_web_service && var.web_allow_unauthenticated ? 1 : 0

  project  = var.project_id
  location = google_cloud_run_v2_service.web[0].location
  name     = google_cloud_run_v2_service.web[0].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
