import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const OBSERVABILITY_TERRAFORM = new URL(
  '../../infrastructure/terraform/environments/nonprod/observability.tf',
  import.meta.url,
);
const DASHBOARD_TERRAFORM = new URL(
  '../../infrastructure/terraform/environments/nonprod/operations_dashboard.tf',
  import.meta.url,
);
const WEB_SERVICE_TERRAFORM = new URL(
  '../../infrastructure/terraform/environments/nonprod/web_service.tf',
  import.meta.url,
);
const CONTROLLED_ALERT_SCRIPT = new URL(
  '../../scripts/test-task8-controlled-alert.ps1',
  import.meta.url,
);

test('Terraform defines the required operational resources', async () => {
  const [observability, dashboard] = await Promise.all([
    readFile(OBSERVABILITY_TERRAFORM, 'utf8'),
    readFile(DASHBOARD_TERRAFORM, 'utf8'),
  ]);

  for (const required of [
    'google_logging_metric',
    'google_monitoring_alert_policy',
    'google_monitoring_uptime_check_config',
    'reconciliation success missing',
    'controlled alert pipeline test',
    'cloudsql.googleapis.com/database/postgresql/num_backends',
    'resource.type=\\"cloud_run_revision\\"',
    'resource_types   = ["cloud_run_worker_pool"]',
    'resource.type=\\"cloud_run_job\\"',
    'resource.type=\\"cloud_scheduler_job\\"',
    'resource.type=\\"global\\"',
    'condition_prometheus_query_language',
    'absent_over_time',
    '[25h]',
  ]) {
    assert.ok(observability.includes(required), `missing observability contract: ${required}`);
  }
  for (const required of [
    'SkyOS nonprod operations',
    'run.googleapis.com/request_count',
    'storage.googleapis.com/api/request_count',
    'Cloud SQL connections',
    'resource.type=\\"cloud_run_worker_pool\\"',
    'resource.type=\\"cloud_run_job\\"',
  ]) {
    assert.ok(dashboard.includes(required), `missing dashboard contract: ${required}`);
  }

  assert.match(dashboard, /plotType\s+=\s+"STACKED_BAR"/u);

  assert.equal(observability.includes('duration = "93600s"'), false);
  assert.equal(observability.includes('[26h]'), false);
  assert.equal(dashboard.includes('plotType = "BAR"'), false);
  assert.equal(dashboard.includes('color = "YELLOW"'), false);
  assert.equal(dashboard.includes('direction = "ABOVE"'), false);
  assert.equal(dashboard.includes('xPos   = 0'), false);
  assert.equal(dashboard.includes('yPos   = 0'), false);

  const plotTypeCount = [...dashboard.matchAll(/plotType\s+=/gu)].length;
  const targetAxisCount = [...dashboard.matchAll(/targetAxis\s+=\s+"Y1"/gu)].length;
  assert.ok(plotTypeCount > 0);
  assert.equal(targetAxisCount, plotTypeCount);

  const controlledAlert = observability.slice(
    observability.indexOf('resource "google_monitoring_alert_policy" "controlled_alert"'),
  );
  assert.ok(controlledAlert.includes('auto_close = "1800s"'));
  assert.equal(controlledAlert.includes('auto_close = "600s"'), false);

  const alertPolicies = observability.slice(
    observability.indexOf('resource "google_monitoring_alert_policy"'),
  );
  const alertFilters = [...alertPolicies.matchAll(/^\s+filter\s+=\s+"(.+)"$/gmu)].map(
    (match) => match[1],
  );
  const dashboardFilters = [...dashboard.matchAll(/^\s+filter\s+=\s+"(.+)"$/gmu)].map(
    (match) => match[1],
  );

  assert.ok(alertFilters.length > 0);
  assert.ok(dashboardFilters.length > 0);
  for (const filter of [...alertFilters, ...dashboardFilters]) {
    assert.ok(filter.includes('resource.type='), `metric filter has no resource type: ${filter}`);
  }
});

test('log-based metric label keys exclude high-cardinality identifiers and content', async () => {
  const terraform = await readFile(OBSERVABILITY_TERRAFORM, 'utf8');
  const labelKeys = [...terraform.matchAll(/labels\s*\{[^}]*?key\s*=\s*"([^"]+)"/gsu)].map(
    (match) => match[1],
  );

  assert.ok(labelKeys.length > 0);
  for (const forbidden of [
    'user_id',
    'request_id',
    'run_id',
    'document_id',
    'workspace_id',
    'filename',
    'url',
    'prompt',
  ]) {
    assert.equal(labelKeys.includes(forbidden), false, `${forbidden} must not be a metric label`);
  }
});

test('web receives the provider assignments required before durable enqueue', async () => {
  const webService = await readFile(WEB_SERVICE_TERRAFORM, 'utf8');

  assert.match(
    webService,
    /dynamic "env" \{\s+for_each = local\.durable_ai_role_env\s+content \{/u,
  );
});

test('controlled alert verification waits beyond the provider auto-close window', async () => {
  const script = await readFile(CONTROLLED_ALERT_SCRIPT, 'utf8');

  assert.match(script, /\$Attempt -le 160/u);
  assert.match(script, /within forty minutes after opening/u);
  assert.match(script, /logging\.googleapis\.com\/v2\/entries:write/u);
  assert.match(script, /logging\.googleapis\.com\/v2\/entries:list/u);
  assert.match(script, /ConvertTo-Json -Depth 10/u);
  assert.match(script, /\[string\]\$ExistingTestId/u);
  assert.match(script, /"x-goog-user-project" = \$ProjectId/u);
  assert.match(script, /alerts\?pageSize=100/u);
  assert.equal(script.includes('alerts?orderBy='), false);
  assert.equal(script.includes('gcloud logging write'), false);
  assert.equal(script.includes('gcloud logging read'), false);
});
