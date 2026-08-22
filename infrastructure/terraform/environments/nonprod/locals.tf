locals {
  primary_region = "europe-west1"

  common_labels = {
    application = "skyos"
    environment = "nonprod"
    component   = "knowledge"
  }

  workload_service_accounts = {
    web = {
      account_id   = "skyos-np-web"
      display_name = "SkyOS non-production web"
    }
    worker = {
      account_id   = "skyos-np-worker"
      display_name = "SkyOS non-production worker"
    }
    migrator = {
      account_id   = "skyos-np-migrator"
      display_name = "SkyOS non-production migrator"
    }
    reconciliation = {
      account_id   = "skyos-np-reconcile"
      display_name = "SkyOS non-production reconciliation"
    }
  }

  storage_runtime_workloads = toset(["web", "worker", "reconciliation"])
}
