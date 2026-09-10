resource "google_project_service" "cloud_scheduler" {
  project = var.project_id
  service = "cloudscheduler.googleapis.com"

  disable_on_destroy = false
}

resource "google_service_account" "reconciliation_scheduler_invoker" {
  project      = var.project_id
  account_id   = "skyos-np-reconcile-invoker"
  display_name = "SkyOS non-production reconciliation scheduler invoker"
  description  = "Dedicated Cloud Scheduler identity permitted to invoke only the SkyOS reconciliation job."

  depends_on = [google_project_service.iam]
}

resource "google_cloud_run_v2_job_iam_member" "reconciliation_scheduler_invoker" {
  project  = var.project_id
  location = google_cloud_run_v2_job.reconciliation.location
  name     = google_cloud_run_v2_job.reconciliation.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.reconciliation_scheduler_invoker.email}"
}

resource "google_cloud_scheduler_job" "reconciliation_daily" {
  project     = var.project_id
  region      = local.primary_region
  name        = "skyos-np-reconcile-daily"
  description = "Daily report-only SkyOS background-job and Knowledge storage reconciliation."

  schedule  = "17 3 * * *"
  time_zone = "Etc/UTC"

  # Keep the trigger disabled until the first operator-run reconciliation
  # has completed successfully and its logs have been reviewed.
  paused           = false
  attempt_deadline = "60s"

  retry_config {
    retry_count = 0
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${google_cloud_run_v2_job.reconciliation.location}/jobs/${google_cloud_run_v2_job.reconciliation.name}:run"
    body        = base64encode("{}")

    headers = {
      "Content-Type" = "application/json"
    }

    oauth_token {
      service_account_email = google_service_account.reconciliation_scheduler_invoker.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.cloud_scheduler,
    google_cloud_run_v2_job.reconciliation,
    google_cloud_run_v2_job_iam_member.reconciliation_scheduler_invoker,
  ]
}