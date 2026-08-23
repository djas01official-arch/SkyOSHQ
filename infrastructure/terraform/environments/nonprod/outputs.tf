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
  description = "Cloud Run web workload identity."
  value       = google_service_account.workload["web"].email
}

output "worker_service_account_email" {
  description = "Future Cloud Run worker workload identity."
  value       = google_service_account.workload["worker"].email
}

output "migrator_service_account_email" {
  description = "Cloud Run migrator workload identity."
  value       = google_service_account.workload["migrator"].email
}

output "reconciliation_service_account_email" {
  description = "Future Cloud Run reconciliation workload identity."
  value       = google_service_account.workload["reconciliation"].email
}

output "runtime_image_repository_id" {
  description = "Artifact Registry repository ID for the shared SkyOS runtime image."
  value       = google_artifact_registry_repository.runtime_images.repository_id
}

output "runtime_image_repository_name" {
  description = "Artifact Registry repository resource name for the shared SkyOS runtime image."
  value       = google_artifact_registry_repository.runtime_images.name
}

output "runtime_image_repository_region" {
  description = "Artifact Registry region for the shared SkyOS runtime image."
  value       = google_artifact_registry_repository.runtime_images.location
}

output "runtime_image_repository_docker_path" {
  description = "Canonical Docker repository path for the shared SkyOS runtime image."
  value       = "${local.primary_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.runtime_images.repository_id}"
}

output "network_name" {
  description = "Dedicated SkyOS non-production VPC network name."
  value       = google_compute_network.skyos.name
}

output "network_self_link" {
  description = "Dedicated SkyOS non-production VPC network self link."
  value       = google_compute_network.skyos.self_link
}

output "runtime_subnet_name" {
  description = "Cloud Run Direct VPC runtime subnet name."
  value       = google_compute_subnetwork.runtime.name
}

output "runtime_subnet_region" {
  description = "Cloud Run Direct VPC runtime subnet region."
  value       = google_compute_subnetwork.runtime.region
}

output "runtime_subnet_cidr" {
  description = "Cloud Run Direct VPC runtime subnet CIDR range."
  value       = google_compute_subnetwork.runtime.ip_cidr_range
}

output "private_services_access_range_name" {
  description = "Reserved Private Services Access peering range name."
  value       = google_compute_global_address.private_services_access.name
}

output "cloud_sql_instance_name" {
  description = "Non-production Cloud SQL PostgreSQL instance name."
  value       = google_sql_database_instance.postgres.name
}

output "cloud_sql_connection_name" {
  description = "Non-production Cloud SQL PostgreSQL connection name."
  value       = google_sql_database_instance.postgres.connection_name
}

output "cloud_sql_private_ip" {
  description = "Non-production Cloud SQL PostgreSQL private IP address."
  value       = google_sql_database_instance.postgres.private_ip_address
}

output "cloud_sql_database_version" {
  description = "Non-production Cloud SQL PostgreSQL database version."
  value       = google_sql_database_instance.postgres.database_version
}

output "application_database_user_name" {
  description = "Restricted application database login when enable_application_database_user is true."
  value       = try(google_sql_user.application[0].name, null)
}

output "application_database_password_secret_id" {
  description = "Secret Manager secret ID holding the application database password. The password value is never exposed."
  value       = google_secret_manager_secret.application_database_password.secret_id
}

output "web_runtime_secret_ids" {
  description = "Secret Manager secret IDs reserved for the SkyOS web runtime. Values are never exposed by this output."
  value = {
    for env_name, secret in google_secret_manager_secret.web_runtime :
    env_name => secret.secret_id
  }
}

output "web_service_name" {
  description = "Cloud Run web service name when enable_web_service is true."
  value       = try(google_cloud_run_v2_service.web[0].name, null)
}

output "web_service_uri" {
  description = "Cloud Run web service URI when enable_web_service is true."
  value       = try(google_cloud_run_v2_service.web[0].uri, null)
}
