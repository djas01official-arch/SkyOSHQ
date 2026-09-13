locals {
  observability_log_filter = "jsonPayload.environment=\"nonprod\""

  application_alerts = {
    worker_failures = {
      display_name     = "SkyOS nonprod: sustained durable worker failures"
      condition_name   = "Three or more terminal failures in ten minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_job_events.name}\" AND metric.label.operation=\"background_job.failed\""
      threshold        = 2
      alignment_period = "600s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "1800s"
      guidance         = "Inspect error_category, job_kind, attempts, leases, and queue age before retrying work."
      resource_types   = ["cloud_run_worker_pool"]
    }
    worker_backlog = {
      display_name     = "SkyOS nonprod: durable work stuck"
      condition_name   = "Oldest queued work remains above five minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_job_backlog_age.name}\""
      threshold        = 300000
      alignment_period = "60s"
      aligner          = "ALIGN_PERCENTILE_99"
      duration         = "600s"
      auto_close       = "1800s"
      guidance         = "Five minutes is five times the default lease and above normal polling. Check worker capacity and expired leases."
      resource_types   = ["cloud_run_worker_pool"]
    }
    stuck_domain_work = {
      display_name     = "SkyOS nonprod: durable domain work stuck"
      condition_name   = "Five degraded snapshots in ten minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.stuck_work.name}\""
      threshold        = 4
      alignment_period = "600s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "1800s"
      guidance         = "AI RUNNING older than 30 minutes or Knowledge processing older than 15 minutes requires correlated inspection."
      resource_types   = ["cloud_run_worker_pool"]
    }
    ai_failures = {
      display_name     = "SkyOS nonprod: sustained AI failures"
      condition_name   = "Four or more failed AI runs in ten minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_run_events.name}\" AND metric.label.status=\"FAILED\""
      threshold        = 3
      alignment_period = "600s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "1800s"
      guidance         = "Group by provider and error_category. Contain using provider or mode controls without inspecting prompts."
      resource_types   = ["cloud_run_revision", "cloud_run_worker_pool"]
    }
    ai_rate_limits = {
      display_name     = "SkyOS nonprod: sustained AI rate limits"
      condition_name   = "Four or more rate-limit outcomes in ten minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_run_events.name}\" AND metric.label.error_category=\"rate_limit\""
      threshold        = 3
      alignment_period = "600s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "1800s"
      guidance         = "Check provider quotas and retry pressure. Do not increase concurrency until backlog and provider status are understood."
      resource_types   = ["cloud_run_revision", "cloud_run_worker_pool"]
    }
    knowledge_failures = {
      display_name     = "SkyOS nonprod: sustained Knowledge embedding failure"
      condition_name   = "Four failed embedding outcomes in fifteen minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.knowledge_embedding_events.name}\" AND metric.label.status=\"FAILED\""
      threshold        = 3
      alignment_period = "900s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "3600s"
      guidance         = "Check provider health, dimensions, worker backlog, and reconciliation before repairing lifecycle state."
      resource_types   = ["cloud_run_worker_pool"]
    }
    reconciliation_drift = {
      display_name     = "SkyOS nonprod: critical reconciliation drift"
      condition_name   = "An actionable drift or repair failure was found"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.reconciliation_drift.name}\""
      threshold        = 0
      alignment_period = "300s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "3600s"
      guidance         = "Archived objects alone are not drift. Review bounded counts, then run report-only reconciliation before repair."
      resource_types   = ["cloud_run_job"]
    }
    security_denials = {
      display_name     = "SkyOS nonprod: repeated access denials"
      condition_name   = "Twenty-five authentication or authorization denials in ten minutes"
      filter           = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.security_denials.name}\""
      threshold        = 24
      alignment_period = "600s"
      aligner          = "ALIGN_SUM"
      duration         = "0s"
      auto_close       = "3600s"
      guidance         = "Ticket for investigation. Logs intentionally omit user identifiers, cookies, headers, and credential values."
      resource_types   = ["cloud_run_revision"]
    }
  }
}

resource "google_logging_metric" "ai_run_events" {
  project     = var.project_id
  name        = "skyos_ai_run_events"
  description = "Terminal SkyOS AI runs by bounded operational labels."
  filter      = "${local.observability_log_filter} AND jsonPayload.operation=\"ai.run_terminal\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "Terminal status."
    }
    labels {
      key         = "provider"
      value_type  = "STRING"
      description = "Configured provider key."
    }
    labels {
      key         = "error_category"
      value_type  = "STRING"
      description = "Bounded error category."
    }
  }
  label_extractors = {
    status         = "EXTRACT(jsonPayload.status)"
    provider       = "EXTRACT(jsonPayload.provider)"
    error_category = "EXTRACT(jsonPayload.error_category)"
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "ai_run_latency" {
  project = var.project_id
  name    = "skyos_ai_run_latency_ms"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"ai.run_terminal\" AND jsonPayload.duration_ms:*"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.duration_ms)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 10
    }
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "ai_orchestration_events" {
  project = var.project_id
  name    = "skyos_ai_orchestration_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"ai.orchestration_terminal\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "mode"
      value_type  = "STRING"
      description = "Bounded AI mode."
    }
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "Terminal status."
    }
  }
  label_extractors = { mode = "EXTRACT(jsonPayload.mode)", status = "EXTRACT(jsonPayload.status)" }
  depends_on       = [google_project_service.logging]
}

resource "google_logging_metric" "background_job_events" {
  project = var.project_id
  name    = "skyos_background_job_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=(\"background_job.completed\" OR \"background_job.retry_scheduled\" OR \"background_job.failed\" OR \"background_job.lease_expired\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "operation"
      value_type  = "STRING"
      description = "Bounded lifecycle event."
    }
    labels {
      key         = "job_kind"
      value_type  = "STRING"
      description = "Bounded durable job kind."
    }
  }
  label_extractors = { operation = "EXTRACT(jsonPayload.operation)", job_kind = "EXTRACT(jsonPayload.job_kind)" }
  depends_on       = [google_project_service.logging]
}

resource "google_logging_metric" "background_job_backlog_age" {
  project = var.project_id
  name    = "skyos_background_job_oldest_queued_age_ms"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"background_job.backlog_snapshot\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "ms"
  }
  value_extractor = "EXTRACT(jsonPayload.oldest_queued_age_ms)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 20
      growth_factor      = 2
      scale              = 1000
    }
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "stuck_work" {
  project = var.project_id
  name    = "skyos_stuck_work_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"background_job.backlog_snapshot\" AND jsonPayload.status=\"DEGRADED\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "knowledge_embedding_events" {
  project = var.project_id
  name    = "skyos_knowledge_embedding_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"knowledge.embedding_terminal\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "Embedding status."
    }
    labels {
      key         = "error_category"
      value_type  = "STRING"
      description = "Bounded error category."
    }
  }
  label_extractors = { status = "EXTRACT(jsonPayload.status)", error_category = "EXTRACT(jsonPayload.error_category)" }
  depends_on       = [google_project_service.logging]
}

resource "google_logging_metric" "reconciliation_events" {
  project = var.project_id
  name    = "skyos_reconciliation_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"reconciliation.run_terminal\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "status"
      value_type  = "STRING"
      description = "Execution status."
    }
  }
  label_extractors = { status = "EXTRACT(jsonPayload.status)" }
  depends_on       = [google_project_service.logging]
}

resource "google_logging_metric" "reconciliation_drift" {
  project = var.project_id
  name    = "skyos_reconciliation_drift_events"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=\"reconciliation.run_terminal\" AND (jsonPayload.drift_count>0 OR jsonPayload.repair_failed_count>0)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "security_denials" {
  project = var.project_id
  name    = "skyos_security_denials"
  filter  = "${local.observability_log_filter} AND jsonPayload.operation=(\"security.authentication_failure\" OR \"security.authorization_failure\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "operation"
      value_type  = "STRING"
      description = "Bounded denial class."
    }
  }
  label_extractors = { operation = "EXTRACT(jsonPayload.operation)" }
  depends_on       = [google_project_service.logging]
}

resource "google_logging_metric" "controlled_alert" {
  project = var.project_id
  name    = "skyos_controlled_alert_events"
  filter  = "jsonPayload.operation=\"observability.alert_test\" AND jsonPayload.environment=\"nonprod\" AND jsonPayload.service=\"operator\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.logging]
}

resource "google_logging_metric" "reconciliation_scheduler_failures" {
  project = var.project_id
  name    = "skyos_reconciliation_scheduler_failures"
  filter  = "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"skyos-np-reconcile-daily\" AND severity>=ERROR"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.logging]
}

resource "google_monitoring_uptime_check_config" "web_liveness" {
  count        = var.enable_web_service && var.web_allow_unauthenticated ? 1 : 0
  project      = var.project_id
  display_name = "SkyOS nonprod web liveness"
  period       = "300s"
  timeout      = "10s"
  monitored_resource {
    type = "uptime_url"
    labels = {
      host       = trimsuffix(trimprefix(google_cloud_run_v2_service.web[0].uri, "https://"), "/")
      project_id = var.project_id
    }
  }
  http_check {
    path         = "/api/health/live"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  log_check_failures = true
  depends_on         = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "application" {
  for_each = local.application_alerts

  project               = var.project_id
  display_name          = each.value.display_name
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  dynamic "conditions" {
    for_each = toset(each.value.resource_types)

    content {
      display_name = "${each.value.condition_name} (${conditions.value})"
      condition_threshold {
        filter          = "resource.type=\"${conditions.value}\" AND ${each.value.filter}"
        comparison      = "COMPARISON_GT"
        threshold_value = each.value.threshold
        duration        = each.value.duration
        aggregations {
          alignment_period     = each.value.alignment_period
          per_series_aligner   = each.value.aligner
          cross_series_reducer = "REDUCE_SUM"
        }
        trigger {
          count = 1
        }
      }
    }
  }
  alert_strategy {
    auto_close = each.value.auto_close
  }
  documentation {
    content   = "${each.value.guidance} Follow docs/operations/incident-response.md."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "web_5xx_rate" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: sustained web 5xx ratio"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "5xx responses exceed 5 percent for 10 minutes"
    condition_threshold {
      filter             = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.label.response_code_class=\"5xx\""
      denominator_filter = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = 0.05
      duration           = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      denominator_aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
  documentation {
    content   = "Page after sustained server-error impact. Follow docs/operations/incident-response.md."
    mime_type = "text/markdown"
  }
  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "web_latency" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: sustained web p95 latency"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "p95 request latency exceeds three seconds for ten minutes"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = 3000
      duration        = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
  documentation {
    content   = "Inspect Cloud Run, Cloud SQL, and AI dependency panels. Follow docs/operations/incident-response.md."
    mime_type = "text/markdown"
  }
  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "runtime_probe_failures" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: repeated Cloud Run probe failures"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  dynamic "conditions" {
    for_each = {
      web = {
        resource_type = "cloud_run_revision"
        resource_name = "resource.label.service_name=\"skyos-np-web\""
      }
      worker = {
        resource_type = "cloud_run_worker_pool"
        resource_name = "resource.label.worker_pool_name=\"skyos-np-worker\""
      }
    }

    content {
      display_name = "More than two failed probes in ten minutes (${conditions.key})"
      condition_threshold {
        filter          = "resource.type=\"${conditions.value.resource_type}\" AND ${conditions.value.resource_name} AND metric.type=\"run.googleapis.com/container/completed_probe_count\" AND metric.label.is_healthy=\"false\""
        comparison      = "COMPARISON_GT"
        threshold_value = 2
        duration        = "0s"
        aggregations {
          alignment_period     = "600s"
          per_series_aligner   = "ALIGN_SUM"
          cross_series_reducer = "REDUCE_SUM"
        }
        trigger {
          count = 1
        }
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
  documentation {
    content   = "Check startup, crash loops, readiness, and recent image changes. Follow docs/operations/incident-response.md."
    mime_type = "text/markdown"
  }
  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "web_uptime" {
  count = var.enable_web_service && var.web_allow_unauthenticated ? 1 : 0

  project               = var.project_id
  display_name          = "SkyOS nonprod: major web availability degradation"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "Public liveness fails from two regions for five minutes"
    condition_threshold {
      filter          = "resource.type=\"uptime_url\" AND resource.label.host=\"${trimsuffix(trimprefix(google_cloud_run_v2_service.web[0].uri, "https://"), "/")}\" AND metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\""
      comparison      = "COMPARISON_LT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_FRACTION_TRUE"
      }
      trigger {
        count = 2
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
  documentation {
    content   = "Page for externally confirmed availability loss. Check revision health, ingress, and platform status."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "reconciliation_execution_failure" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: reconciliation execution or schedule failure"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "Cloud Run reconciliation execution failed"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND resource.label.job_name=\"skyos-np-reconcile\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.label.result=\"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  conditions {
    display_name = "Cloud Scheduler invocation failed"
    condition_threshold {
      filter          = "resource.type=\"cloud_scheduler_job\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.reconciliation_scheduler_failures.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "3600s"
  }
  documentation {
    content   = "Check both Scheduler delivery and the Cloud Run Job execution before manual invocation."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "reconciliation_failure" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: repeated reconciliation failure"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "Two failed executions in 25 hours"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_job\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.reconciliation_events.name}\" AND metric.label.status=\"FAILED\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "0s"
      aggregations {
        alignment_period     = "90000s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "3600s"
  }
  documentation {
    content   = "Check the daily Cloud Run Job and scheduler invocation. Follow docs/operations/incident-response.md."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "reconciliation_absent" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: reconciliation success missing"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "No successful daily reconciliation within 25 hours"
    condition_prometheus_query_language {
      query                     = "absent_over_time(logging_googleapis_com:user_${google_logging_metric.reconciliation_events.name}{monitored_resource=\"cloud_run_job\",status=\"SUCCEEDED\"}[25h])"
      duration                  = "0s"
      evaluation_interval       = "300s"
      disable_metric_validation = true
      rule_group                = "skyos_reconciliation"
      alert_rule                = "ReconciliationSuccessMissing"
    }
  }
  alert_strategy {
    auto_close = "3600s"
  }
  documentation {
    content   = "The schedule runs daily at 03:17 UTC. Check Scheduler and Cloud Run Job state. Follow the incident runbook."
    mime_type = "text/markdown"
  }
}

resource "google_monitoring_alert_policy" "cloud_sql_saturation" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: Cloud SQL saturation"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  dynamic "conditions" {
    for_each = {
      cpu = {
        name      = "CPU above 80 percent for 15 minutes"
        metric    = "cloudsql.googleapis.com/database/cpu/utilization"
        threshold = 0.80
      }
      memory = {
        name      = "Memory above 85 percent for 15 minutes"
        metric    = "cloudsql.googleapis.com/database/memory/utilization"
        threshold = 0.85
      }
      disk = {
        name      = "Disk above 80 percent for 15 minutes"
        metric    = "cloudsql.googleapis.com/database/disk/utilization"
        threshold = 0.80
      }
    }
    content {
      display_name = conditions.value.name
      condition_threshold {
        filter          = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"${conditions.value.metric}\""
        comparison      = "COMPARISON_GT"
        threshold_value = conditions.value.threshold
        duration        = "900s"
        aggregations {
          alignment_period     = "300s"
          per_series_aligner   = "ALIGN_MEAN"
          cross_series_reducer = "REDUCE_MAX"
        }
        trigger {
          count = 1
        }
      }
    }
  }
  conditions {
    display_name = "PostgreSQL connections exceed 80 for ten minutes"
    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = 80
      duration        = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_MAX"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "3600s"
  }
  documentation {
    content   = "Ticket sustained pressure; do not resize from one spike. Task 9 will load-qualify thresholds."
    mime_type = "text/markdown"
  }
  depends_on = [google_project_service.monitoring]
}

resource "google_monitoring_alert_policy" "controlled_alert" {
  project               = var.project_id
  display_name          = "SkyOS nonprod: controlled alert pipeline test"
  combiner              = "OR"
  notification_channels = var.observability_notification_channels
  conditions {
    display_name = "Safe controlled event observed"
    condition_threshold {
      filter          = "resource.type=\"global\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.controlled_alert.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    auto_close = "1800s"
  }
  documentation {
    content   = "Controlled validation only. Emit one safe event and capture incident open/close evidence."
    mime_type = "text/markdown"
  }
}
