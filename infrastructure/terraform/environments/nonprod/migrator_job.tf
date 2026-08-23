resource "google_cloud_run_v2_job" "migrator_role_bootstrap" {
  project             = var.project_id
  name                = "skyos-np-migrator-role-bootstrap"
  location            = local.primary_region
  deletion_protection = true

  labels = {
    application = "skyos"
    environment = "nonprod"
    component   = "database-role-bootstrap"
  }

  template {
    task_count  = 1
    parallelism = 1

    template {
      service_account       = google_service_account.workload["migrator"].email
      max_retries           = 0
      timeout               = "600s"
      execution_environment = "EXECUTION_ENVIRONMENT_GEN2"

      containers {
        image   = var.runtime_image
        command = ["/bin/sh"]
        args = [
          "-c",
          <<-SHELL
          set -eu
          export DATABASE_URL="postgresql://$${DB_USER}:$${DB_PASSWORD}@$${DB_HOST}:$${DB_PORT}/$${DB_NAME}"
          exec /app/node_modules/.bin/tsx /app/database/scripts/bootstrap-production-database-roles.ts
          SHELL
        ]

        env {
          name  = "DB_USER"
          value = "skyos_migrator"
        }

        env {
          name  = "DB_NAME"
          value = "skyos"
        }

        env {
          name  = "DB_PORT"
          value = "5432"
        }

        env {
          name  = "DB_HOST"
          value = google_sql_database_instance.postgres.private_ip_address
        }

        env {
          name = "DB_PASSWORD"

          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.migration_database_password.secret_id
              version = google_secret_manager_secret_version.migration_database_password.version
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

  depends_on = [
    google_project_service.cloud_run,
    google_secret_manager_secret_iam_member.migration_database_password_accessor,
  ]
}
