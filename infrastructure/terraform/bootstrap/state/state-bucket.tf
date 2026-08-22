resource "google_storage_bucket" "terraform_state" {
  name                        = var.terraform_state_bucket_name
  project                     = var.project_id
  location                    = local.primary_region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.state_bucket_labels

  soft_delete_policy {
    retention_duration_seconds = 604800
  }

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.storage]
}
