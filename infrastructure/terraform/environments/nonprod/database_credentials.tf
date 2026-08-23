resource "google_sql_user" "migrator" {
  project             = var.project_id
  instance            = google_sql_database_instance.postgres.name
  name                = "skyos_migrator"
  type                = "BUILT_IN"
  password_wo         = var.migration_database_password
  password_wo_version = 1
  database_roles      = ["cloudsqlsuperuser"]
  deletion_policy     = "PREVENT"
}

resource "google_secret_manager_secret" "migration_database_password" {
  project             = var.project_id
  secret_id           = "skyos-np-db-migrator-password"
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
}

resource "google_secret_manager_secret_version" "migration_database_password" {
  secret                 = google_secret_manager_secret.migration_database_password.id
  secret_data_wo         = var.migration_database_password
  secret_data_wo_version = 1
  deletion_policy        = "DISABLE"
}

resource "google_secret_manager_secret_iam_member" "migration_database_password_accessor" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.migration_database_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.workload["migrator"].email}"
}
