resource "google_cloud_run_v2_worker_pool" "worker" {
  project             = var.project_id
  name                = "skyos-np-worker"
  location            = local.primary_region
  deletion_protection = true

  labels = merge(local.common_labels, {
    component = "worker"
  })

  template {
    service_account = google_service_account.workload["worker"].email

    containers {
      image   = var.runtime_image
      command = ["pnpm"]
      args    = ["worker"]

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      env {
        name  = "BACKGROUND_JOB_MODE"
        value = "durable"
      }

      env {
        name  = "pnpm_config_verify_deps_before_run"
        value = "false"
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
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      env {
        name  = "EMBEDDING_PROVIDER"
        value = "vertex"
      }

      env {
        name  = "EMBEDDING_MODEL"
        value = "gemini-embedding-001"
      }

      env {
        name  = "EMBEDDING_MODEL_VERSION"
        value = "retrieval-v1"
      }

      env {
        name  = "EMBEDDING_DIMENSIONS"
        value = "768"
      }

      env {
        name  = "EMBEDDING_LOCATION"
        value = local.primary_region
      }

      env {
        name = "DATABASE_URL"

        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.web_runtime["DATABASE_URL"].secret_id
            version = lookup(var.web_secret_versions, "DATABASE_URL", "")
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

  scaling {
    scaling_mode          = "MANUAL"
    manual_instance_count = 1
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[1-9][0-9]*$", lookup(var.web_secret_versions, "DATABASE_URL", "")))
      error_message = "Creating the worker pool requires a pinned DATABASE_URL Secret Manager version."
    }
  }

  depends_on = [
    google_project_service.cloud_run,
    google_project_iam_member.worker_vertex_prediction_runtime,
    google_secret_manager_secret_iam_member.worker_database_url_accessor,
  ]
}
