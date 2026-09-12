resource "google_project_iam_custom_role" "knowledge_object_runtime" {
  project     = var.project_id
  role_id     = "skyosKnowledgeObjectRuntime"
  title       = "SkyOS Knowledge object runtime"
  description = "Exact create, read, and compensating-delete permissions required by the SkyOS web upload boundary."
  stage       = "GA"

  permissions = [
    "storage.objects.create",
    "storage.objects.get",
    "storage.objects.delete",
  ]

  depends_on = [google_project_service.iam]
}

resource "google_project_iam_custom_role" "knowledge_object_worker" {
  project     = var.project_id
  role_id     = "skyosKnowledgeObjectWorker"
  title       = "SkyOS Knowledge object worker"
  description = "Read-only object permission required by the SkyOS ingestion worker."
  stage       = "GA"

  permissions = [
    "storage.objects.get",
  ]

  depends_on = [google_project_service.iam]
}

resource "google_project_iam_custom_role" "knowledge_object_reconciliation" {
  project     = var.project_id
  role_id     = "skyosKnowledgeObjectReconcile"
  title       = "SkyOS Knowledge object reconciliation"
  description = "Read and bounded-list permissions required by report-only Knowledge reconciliation."
  stage       = "GA"

  permissions = [
    "storage.objects.get",
    "storage.objects.list",
  ]

  depends_on = [google_project_service.iam]
}

resource "google_storage_bucket_iam_member" "knowledge_object_runtime" {
  for_each = local.storage_runtime_workloads

  bucket = google_storage_bucket.knowledge.name
  role   = google_project_iam_custom_role.knowledge_object_runtime.name
  member = "serviceAccount:${google_service_account.workload[each.key].email}"
}

resource "google_storage_bucket_iam_member" "knowledge_object_worker" {
  bucket = google_storage_bucket.knowledge.name
  role   = google_project_iam_custom_role.knowledge_object_worker.name
  member = "serviceAccount:${google_service_account.workload["worker"].email}"
}

resource "google_storage_bucket_iam_member" "knowledge_object_reconciliation" {
  bucket = google_storage_bucket.knowledge.name
  role   = google_project_iam_custom_role.knowledge_object_reconciliation.name
  member = "serviceAccount:${google_service_account.workload["reconciliation"].email}"
}
resource "google_project_iam_custom_role" "vertex_prediction_runtime" {
  project     = var.project_id
  role_id     = "skyosVertexPredictionRuntime"
  title       = "SkyOS Vertex prediction runtime"
  description = "Exact Vertex AI prediction permission required by SkyOS model runtimes."
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

resource "google_project_iam_member" "worker_vertex_prediction_runtime" {
  project = var.project_id
  role    = google_project_iam_custom_role.vertex_prediction_runtime.name
  member  = "serviceAccount:${google_service_account.workload["worker"].email}"
}
