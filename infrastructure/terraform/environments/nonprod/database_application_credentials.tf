resource "google_secret_manager_secret" "application_database_password" {
  project             = var.project_id
  secret_id           = "skyos-np-db-application-password"
  deletion_protection = true

  labels = {
    application = "skyos"
    environment = "nonprod"
    component   = "database-credentials"
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

resource "google_secret_manager_secret_version" "application_database_password" {
  count = var.enable_application_database_user ? 1 : 0

  secret                 = google_secret_manager_secret.application_database_password.id
  secret_data_wo         = var.application_database_password
  secret_data_wo_version = var.application_database_password_version
  deletion_policy        = "DISABLE"

  lifecycle {
    precondition {
      condition     = var.application_database_password_version > 0
      error_message = "Enabling the application database user requires a positive application_database_password_version."
    }
  }
}

resource "google_sql_user" "application" {
  count = var.enable_application_database_user ? 1 : 0

  project             = var.project_id
  instance            = google_sql_database_instance.postgres.name
  name                = "skyos_application"
  type                = "BUILT_IN"
  password_wo         = var.application_database_password
  password_wo_version = var.application_database_password_version
  database_roles      = ["skyos_application_role"]
  deletion_policy     = "PREVENT"

  lifecycle {
    precondition {
      condition     = var.application_database_roles_bootstrapped
      error_message = "Run and verify the migrator role-bootstrap job before enabling the application database user."
    }

    precondition {
      condition     = var.application_database_password_version > 0
      error_message = "Enabling the application database user requires a positive application_database_password_version."
    }
  }

  depends_on = [google_secret_manager_secret_version.application_database_password]
}
