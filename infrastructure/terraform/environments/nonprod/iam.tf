resource "google_project_iam_custom_role" "knowledge_object_runtime" {
  project     = var.project_id
  role_id     = "skyosKnowledgeObjectRuntime"
  title       = "SkyOS Knowledge object runtime"
  description = "Exact object permissions required by the SkyOS Knowledge ObjectStorage port."
  stage       = "GA"

  permissions = [
    "storage.objects.create",
    "storage.objects.get",
    "storage.objects.delete",
  ]

  depends_on = [google_project_service.iam]
}

resource "google_storage_bucket_iam_member" "knowledge_object_runtime" {
  for_each = local.storage_runtime_workloads

  bucket = google_storage_bucket.knowledge.name
  role   = google_project_iam_custom_role.knowledge_object_runtime.name
  member = "serviceAccount:${google_service_account.workload[each.key].email}"
}
