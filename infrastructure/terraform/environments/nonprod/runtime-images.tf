resource "google_artifact_registry_repository" "runtime_images" {
  project       = var.project_id
  location      = local.primary_region
  repository_id = "skyos-np-runtime"
  description   = "Shared immutable SkyOS non-production runtime images."
  format        = "DOCKER"
  labels = merge(local.common_labels, {
    component = "runtime-images"
  })

  docker_config {
    immutable_tags = true
  }

  depends_on = [google_project_service.artifact_registry]
}
