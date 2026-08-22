output "primary_region" {
  description = "Authoritative SkyOS GCP region for this environment."
  value       = local.primary_region
}

output "knowledge_bucket_name" {
  description = "Private non-production Knowledge bucket name."
  value       = google_storage_bucket.knowledge.name
}

output "knowledge_object_runtime_role" {
  description = "Project custom role granted at the Knowledge bucket scope."
  value       = google_project_iam_custom_role.knowledge_object_runtime.name
}

output "web_service_account_email" {
  description = "Future Cloud Run web workload identity."
  value       = google_service_account.workload["web"].email
}

output "worker_service_account_email" {
  description = "Future Cloud Run worker workload identity."
  value       = google_service_account.workload["worker"].email
}

output "migrator_service_account_email" {
  description = "Future Cloud Run migrator workload identity."
  value       = google_service_account.workload["migrator"].email
}

output "reconciliation_service_account_email" {
  description = "Future Cloud Run reconciliation workload identity."
  value       = google_service_account.workload["reconciliation"].email
}
