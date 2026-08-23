resource "google_sql_database_instance" "postgres" {
  project          = var.project_id
  name             = "skyos-np-postgres"
  region           = local.primary_region
  database_version = "POSTGRES_17"

  deletion_protection = true

  settings {
    tier                        = "db-g1-small"
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = 20
    disk_autoresize             = true
    disk_autoresize_limit       = 100
    deletion_protection_enabled = true

    user_labels = {
      application = "skyos"
      environment = "nonprod"
      component   = "database"
    }

    ip_configuration {
      ipv4_enabled       = false
      private_network    = google_compute_network.skyos.id
      allocated_ip_range = google_compute_global_address.private_services_access.name
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      location                       = local.primary_region
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 8
        retention_unit   = "COUNT"
      }
    }
  }

  depends_on = [
    google_project_service.cloud_sql_admin,
    google_service_networking_connection.private_services_access,
  ]
}

resource "google_sql_database" "skyos" {
  project         = var.project_id
  name            = "skyos"
  instance        = google_sql_database_instance.postgres.name
  deletion_policy = "PREVENT"
}
