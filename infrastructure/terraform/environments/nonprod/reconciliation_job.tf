resource "google_secret_manager_secret_iam_member" "reconciliation_database_url_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.web_runtime["DATABASE_URL"].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workload["reconciliation"].email}"
}

resource "google_cloud_run_v2_job" "reconciliation" {
  project             = var.project_id
  name                = "skyos-np-reconcile"
  location            = local.primary_region
  deletion_protection = true

  labels = merge(local.common_labels, {
    component = "reconciliation"
  })

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.workload["reconciliation"].email
      max_retries           = 0
      timeout               = "600s"
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      containers {
        image   = var.runtime_image
        command = ["pnpm"]
        args    = ["jobs:reconcile"]

        env {
          name  = "NODE_ENV"
          value = "production"
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
  }

  lifecycle {
    precondition {
      condition     = can(regex("^[1-9][0-9]*$", lookup(var.web_secret_versions, "DATABASE_URL", "")))
      error_message = "Creating the reconciliation job requires a pinned DATABASE_URL Secret Manager version."
    }
  }

  depends_on = [
    google_project_service.cloud_run,
    google_storage_bucket_iam_member.knowledge_object_reconciliation,
    google_secret_manager_secret_iam_member.reconciliation_database_url_accessor,
  ]
}
