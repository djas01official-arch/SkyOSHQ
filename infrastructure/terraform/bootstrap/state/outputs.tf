output "primary_region" {
  description = "Authoritative SkyOS GCP region for the state bucket."
  value       = local.primary_region
}

output "terraform_state_bucket_name" {
  description = "Private non-production Terraform state bucket name."
  value       = google_storage_bucket.terraform_state.name
}

output "terraform_service_account_email" {
  description = "Future controlled Terraform execution identity."
  value       = google_service_account.terraform.email
}
