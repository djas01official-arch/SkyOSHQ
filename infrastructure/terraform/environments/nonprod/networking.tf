resource "google_compute_network" "skyos" {
  project                 = var.project_id
  name                    = "skyos-np"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"

  depends_on = [google_project_service.compute]
}

resource "google_compute_subnetwork" "runtime" {
  project                  = var.project_id
  name                     = "skyos-np-runtime"
  region                   = local.primary_region
  ip_cidr_range            = "10.40.0.0/24"
  network                  = google_compute_network.skyos.id
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services_access" {
  project       = var.project_id
  name          = "skyos-np-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.skyos.id
}

resource "google_service_networking_connection" "private_services_access" {
  network                 = google_compute_network.skyos.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services_access.name]

  depends_on = [
    google_project_service.service_networking,
    google_compute_global_address.private_services_access,
  ]
}
