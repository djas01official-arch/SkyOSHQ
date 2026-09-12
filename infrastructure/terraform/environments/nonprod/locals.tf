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

  anthropic_web_wif_runtime_env = {
    for name, value in {
      ANTHROPIC_FEDERATION_RULE_ID = var.anthropic_federation_rule_id
      ANTHROPIC_ORGANIZATION_ID    = var.anthropic_organization_id
      ANTHROPIC_SERVICE_ACCOUNT_ID = var.anthropic_service_account_id
      ANTHROPIC_WORKSPACE_ID       = var.anthropic_workspace_id
    } : name => trimspace(value)
    if trimspace(var.anthropic_federation_rule_id) != "" && trimspace(value) != ""
  }

  anthropic_worker_wif_runtime_env = {
    for name, value in {
      ANTHROPIC_FEDERATION_RULE_ID = var.anthropic_worker_federation_rule_id
      ANTHROPIC_ORGANIZATION_ID    = var.anthropic_organization_id
      ANTHROPIC_SERVICE_ACCOUNT_ID = var.anthropic_service_account_id
      ANTHROPIC_WORKSPACE_ID       = var.anthropic_workspace_id
    } : name => trimspace(value)
    if trimspace(var.anthropic_worker_federation_rule_id) != "" && trimspace(value) != ""
  }

  # A workload opts into Anthropic WIF only when its own federation rule is set.
  # Organization/service-account/workspace identifiers are shared metadata and
  # may legitimately be present for the other workload.
  anthropic_web_wif_any_configured    = trimspace(var.anthropic_federation_rule_id) != ""
  anthropic_worker_wif_any_configured = trimspace(var.anthropic_worker_federation_rule_id) != ""

  anthropic_web_wif_required_configured = alltrue([
    for name in [
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
    ] : contains(keys(local.anthropic_web_wif_runtime_env), name)
  ])

  anthropic_worker_wif_required_configured = alltrue([
    for name in [
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_SERVICE_ACCOUNT_ID",
    ] : contains(keys(local.anthropic_worker_wif_runtime_env), name)
  ])
}
