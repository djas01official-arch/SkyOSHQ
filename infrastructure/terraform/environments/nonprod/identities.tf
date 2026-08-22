resource "google_service_account" "workload" {
  for_each = local.workload_service_accounts

  project      = var.project_id
  account_id   = each.value.account_id
  display_name = each.value.display_name
  description  = "Dedicated SkyOS non-production workload identity."

  depends_on = [google_project_service.iam]
}
