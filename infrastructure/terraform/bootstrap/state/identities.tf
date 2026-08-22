resource "google_service_account" "terraform" {
  project      = var.project_id
  account_id   = "skyos-np-terraform"
  display_name = "SkyOS non-production Terraform"
  description  = "Dedicated future Terraform execution identity for SkyOS non-production."

  depends_on = [google_project_service.iam]
}
