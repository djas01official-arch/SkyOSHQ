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
resource "google_project_iam_custom_role" "vertex_prediction_runtime" {
  project     = var.project_id
  role_id     = "skyosVertexPredictionRuntime"
  title       = "SkyOS Vertex prediction runtime"
  description = "Exact Vertex AI permission required by the SkyOS web runtime for Gemini generation."
  stage       = "GA"

  permissions = [
    "aiplatform.endpoints.predict",
  ]

  depends_on = [
    google_project_service.iam,
    google_project_service.aiplatform,
  ]
}

resource "google_project_iam_member" "web_vertex_prediction_runtime" {
  project = var.project_id
  role    = google_project_iam_custom_role.vertex_prediction_runtime.name
  member  = "serviceAccount:${google_service_account.workload["web"].email}"
}
