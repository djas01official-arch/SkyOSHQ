resource "google_monitoring_dashboard" "operations" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "SkyOS nonprod operations"
    mosaicLayout = {
      columns = 48
      tiles = [
        {
          width  = 16
          height = 12
          widget = {
            title = "Web requests by status class"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/request_count\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_RATE"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.response_code_class"]
                  }
                } }
              }]
              yAxis = { label = "requests/s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 16
          width  = 16
          height = 12
          widget = {
            title = "Web p95 latency"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/request_latencies\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_PERCENTILE_95"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              yAxis = { label = "ms", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 32
          width  = 16
          height = 12
          widget = {
            title = "Web CPU and memory"
            xyChart = {
              dataSets = [for metric in ["run.googleapis.com/container/cpu/utilizations", "run.googleapis.com/container/memory/utilizations"] : {
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"${metric}\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_PERCENTILE_95"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              yAxis = { label = "utilization", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 12
          width  = 16
          height = 12
          widget = {
            title = "AI terminal runs"
            xyChart = {
              dataSets = [for resource_type in ["cloud_run_revision", "cloud_run_worker_pool"] : {
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"${resource_type}\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_run_events.name}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.status", "metric.label.provider"]
                  }
                } }
              }]
              yAxis = { label = "runs", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 16
          yPos   = 12
          width  = 16
          height = 12
          widget = {
            title = "AI p95 terminal latency"
            xyChart = {
              dataSets = [for resource_type in ["cloud_run_revision", "cloud_run_worker_pool"] : {
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"${resource_type}\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_run_latency.name}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_PERCENTILE_95"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              yAxis = { label = "ms", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 32
          yPos   = 12
          width  = 16
          height = 12
          widget = {
            title = "Durable orchestration by mode"
            xyChart = {
              dataSets = [for resource_type in ["cloud_run_revision", "cloud_run_worker_pool"] : {
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"${resource_type}\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.ai_orchestration_events.name}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.mode", "metric.label.status"]
                  }
                } }
              }]
              yAxis = { label = "orchestrations", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 24
          width  = 16
          height = 12
          widget = {
            title = "Worker outcomes, retries, leases"
            xyChart = {
              dataSets = [{
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_worker_pool\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_job_events.name}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.operation", "metric.label.job_kind"]
                  }
                } }
              }]
              yAxis = { label = "jobs", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 16
          yPos   = 24
          width  = 16
          height = 12
          widget = {
            title = "Oldest queued durable work"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_worker_pool\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.background_job_backlog_age.name}\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_PERCENTILE_99"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              thresholds = [{ value = 300000, label = "5m stuck threshold" }]
              yAxis      = { label = "ms", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 32
          yPos   = 24
          width  = 16
          height = 12
          widget = {
            title = "Knowledge embedding outcomes"
            xyChart = {
              dataSets = [{
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_worker_pool\" AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.knowledge_embedding_events.name}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.status", "metric.label.error_category"]
                  }
                } }
              }]
              yAxis = { label = "jobs", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 36
          width  = 16
          height = 12
          widget = {
            title = "Reconciliation results"
            xyChart = {
              dataSets = [for metric in [google_logging_metric.reconciliation_events.name, google_logging_metric.reconciliation_drift.name] : {
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_job\" AND metric.type=\"logging.googleapis.com/user/${metric}\""
                  aggregation = {
                    alignmentPeriod    = "3600s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                  }
                } }
              }]
              yAxis = { label = "events", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 16
          yPos   = 36
          width  = 16
          height = 12
          widget = {
            title = "Cloud SQL utilization"
            xyChart = {
              dataSets = [for metric in ["cloudsql.googleapis.com/database/cpu/utilization", "cloudsql.googleapis.com/database/memory/utilization", "cloudsql.googleapis.com/database/disk/utilization"] : {
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"${metric}\""
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_MEAN"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              yAxis = { label = "utilization", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 32
          yPos   = 36
          width  = 16
          height = 12
          widget = {
            title = "Cloud SQL connections"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MEAN"
                    crossSeriesReducer = "REDUCE_MAX"
                  }
                } }
              }]
              yAxis = { label = "connections", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 48
          width  = 24
          height = 12
          widget = {
            title = "Knowledge bucket errors"
            xyChart = {
              dataSets = [{
                plotType   = "STACKED_BAR"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"gcs_bucket\" AND resource.label.bucket_name=\"${google_storage_bucket.knowledge.name}\" AND metric.type=\"storage.googleapis.com/api/request_count\" AND metric.label.response_code=monitoring.regex.full_match(\"4..|5..\")"
                  aggregation = {
                    alignmentPeriod    = "300s"
                    perSeriesAligner   = "ALIGN_SUM"
                    crossSeriesReducer = "REDUCE_SUM"
                    groupByFields      = ["metric.label.response_code", "metric.label.method"]
                  }
                } }
              }]
              yAxis = { label = "errors", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 24
          yPos   = 48
          width  = 24
          height = 12
          widget = {
            title = "Web Cloud Run instances"
            xyChart = {
              dataSets = [{
                plotType   = "LINE"
                targetAxis = "Y1"
                timeSeriesQuery = { timeSeriesFilter = {
                  filter = "resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"skyos-np-web\" AND metric.type=\"run.googleapis.com/container/instance_count\""
                  aggregation = {
                    alignmentPeriod    = "60s"
                    perSeriesAligner   = "ALIGN_MEAN"
                    crossSeriesReducer = "REDUCE_SUM"
                  }
                } }
              }]
              yAxis = { label = "instances", scale = "LINEAR" }
            }
          }
        }
      ]
    }
  })

  depends_on = [
    google_project_service.monitoring,
    google_logging_metric.ai_run_events,
    google_logging_metric.background_job_events,
    google_logging_metric.reconciliation_events,
  ]
}
