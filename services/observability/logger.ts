import { randomUUID } from 'node:crypto';

export const SKYOS_ERROR_CATEGORIES = [
  'validation',
  'authentication',
  'authorization',
  'configuration',
  'provider_transient',
  'provider_permanent',
  'database',
  'storage',
  'timeout',
  'rate_limit',
  'dependency',
  'internal',
] as const;

export type SkyOsErrorCategory = (typeof SKYOS_ERROR_CATEGORIES)[number];
export type SkyOsLogSeverity = 'DEBUG' | 'INFO' | 'NOTICE' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type SkyOsService = 'web' | 'worker' | 'reconciliation' | 'migrator' | 'operator';

type SafeScalar = boolean | number | string | undefined;

export type SkyOsLogFields = Readonly<{
  operation: string;
  request_id?: string;
  run_id?: string;
  orchestration_id?: string;
  document_id?: string;
  attachment_id?: string;
  background_job_id?: string;
  domain_job_id?: string;
  workspace_id?: string;
  status?: string;
  duration_ms?: number;
  error_category?: SkyOsErrorCategory;
  error_code?: string;
  provider?: string;
  model?: string;
  attempt?: number;
  max_attempts?: number;
  job_kind?: string;
  mode?: string;
  requested_mode?: string;
  resolved_mode?: string;
  retry?: boolean;
  batch_size?: number;
  dimensions?: number;
  processed_chunks?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  queued_count?: number;
  active_count?: number;
  oldest_queued_age_ms?: number;
  stuck_ai_count?: number;
  stuck_knowledge_count?: number;
  recovered_count?: number;
  failed_count?: number;
  drift_count?: number;
  repair_attempted_count?: number;
  repair_succeeded_count?: number;
  repair_failed_count?: number;
  result?: string;
  trace_id?: string;
}>;

export type SkyOsLogEntry = Readonly<
  SkyOsLogFields & {
    environment: string;
    service: SkyOsService;
    severity: SkyOsLogSeverity;
    timestamp: string;
    revision?: string;
    deployment_image?: string;
  }
>;

type LogWriter = (line: string, severity: SkyOsLogSeverity) => void;

const SAFE_FIELD_NAMES = new Set<keyof SkyOsLogFields>([
  'operation',
  'request_id',
  'run_id',
  'orchestration_id',
  'document_id',
  'attachment_id',
  'background_job_id',
  'domain_job_id',
  'workspace_id',
  'status',
  'duration_ms',
  'error_category',
  'error_code',
  'provider',
  'model',
  'attempt',
  'max_attempts',
  'job_kind',
  'mode',
  'requested_mode',
  'resolved_mode',
  'retry',
  'batch_size',
  'dimensions',
  'processed_chunks',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'queued_count',
  'active_count',
  'oldest_queued_age_ms',
  'stuck_ai_count',
  'stuck_knowledge_count',
  'recovered_count',
  'failed_count',
  'drift_count',
  'repair_attempted_count',
  'repair_succeeded_count',
  'repair_failed_count',
  'result',
  'trace_id',
]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,119}$/u;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const MAX_TEXT_LENGTH = 200;

function normalizedRuntimeLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized && IDENTIFIER_PATTERN.test(normalized) ? normalized : fallback;
}

function safeText(value: string, maximum = MAX_TEXT_LENGTH): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .trim()
    .slice(0, maximum);
}

function safeFields(fields: SkyOsLogFields): Record<string, boolean | number | string> {
  if (!OPERATION_PATTERN.test(fields.operation)) {
    throw new Error('Observability operation must be a bounded lowercase identifier.');
  }
  const output: Record<string, boolean | number | string> = { operation: fields.operation };
  for (const [key, rawValue] of Object.entries(fields)) {
    if (key === 'operation' || rawValue === undefined || rawValue === null) continue;
    if (!SAFE_FIELD_NAMES.has(key as keyof SkyOsLogFields)) continue;
    const value = rawValue as SafeScalar;
    if (typeof value === 'string') {
      const normalized = safeText(value);
      if (!normalized) continue;
      if (key === 'error_code' && !ERROR_CODE_PATTERN.test(normalized)) continue;
      if (key === 'trace_id' && !TRACE_ID_PATTERN.test(normalized)) continue;
      output[key] = normalized;
      continue;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value >= 0) output[key] = value;
      continue;
    }
    if (typeof value === 'boolean') output[key] = value;
  }
  return output;
}

function defaultWriter(line: string, severity: SkyOsLogSeverity): void {
  if (severity === 'ERROR' || severity === 'CRITICAL') {
    process.stderr.write(`${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

export function createCorrelationId(): string {
  return randomUUID();
}

export function traceIdFromHeaders(headers: Headers): string | undefined {
  const cloudTrace = headers.get('x-cloud-trace-context')?.split('/')[0]?.toLowerCase();
  if (cloudTrace && TRACE_ID_PATTERN.test(cloudTrace)) return cloudTrace;
  const traceParent = headers.get('traceparent')?.split('-')[1]?.toLowerCase();
  return traceParent && TRACE_ID_PATTERN.test(traceParent) ? traceParent : undefined;
}

export function classifyErrorCategory(
  code: string | undefined,
  retryable = false,
): SkyOsErrorCategory {
  const normalized = code?.trim().toLowerCase() ?? '';
  if (/(timeout|deadline)/u.test(normalized)) return 'timeout';
  if (/(rate.?limit|quota)/u.test(normalized)) return 'rate_limit';
  if (/(unauthenticated|authentication|credential|sign.?in)/u.test(normalized)) {
    return 'authentication';
  }
  if (/(forbidden|authorization|permission|access_denied)/u.test(normalized)) {
    return 'authorization';
  }
  if (/(config|secret|environment|model_unavailable)/u.test(normalized)) {
    return 'configuration';
  }
  if (/(storage|gcs|object|generation_mismatch)/u.test(normalized)) return 'storage';
  if (/(database|prisma|postgres|sql|connection)/u.test(normalized)) return 'database';
  if (/(provider|embedding|generation)/u.test(normalized)) {
    return retryable ? 'provider_transient' : 'provider_permanent';
  }
  if (/(invalid|validation|mismatch|unsupported|malformed)/u.test(normalized)) {
    return 'validation';
  }
  if (/(dependency|lease|backlog|stuck|unavailable)/u.test(normalized)) return 'dependency';
  return 'internal';
}

export function safeErrorTelemetry(
  error: unknown,
): Readonly<{ error_category: SkyOsErrorCategory; error_code: string; retry: boolean }> {
  const record =
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const rawCode = typeof record.code === 'string' ? record.code : 'internal_error';
  const errorCode = rawCode
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/gu, '_')
    .slice(0, 80);
  const retry = record.retryable === true;
  return {
    error_category: classifyErrorCategory(errorCode || 'internal_error', retry),
    error_code: errorCode && ERROR_CODE_PATTERN.test(errorCode) ? errorCode : 'internal_error',
    retry,
  };
}

export function createSkyOsLogger(
  service: SkyOsService,
  options: Readonly<{
    environment?: string;
    now?: () => Date;
    writer?: LogWriter;
  }> = {},
) {
  const environment = normalizedRuntimeLabel(
    options.environment ?? process.env.SKYOS_ENVIRONMENT ?? process.env.NODE_ENV,
    'unknown',
  );
  const revision = normalizedRuntimeLabel(process.env.K_REVISION, '');
  const deploymentImage = normalizedRuntimeLabel(process.env.SKYOS_IMAGE_DIGEST, '');
  const now = options.now ?? (() => new Date());
  const writer = options.writer ?? defaultWriter;

  function write(severity: SkyOsLogSeverity, fields: SkyOsLogFields): SkyOsLogEntry {
    const entry = {
      timestamp: now().toISOString(),
      severity,
      service,
      environment,
      ...(revision ? { revision } : {}),
      ...(deploymentImage ? { deployment_image: deploymentImage } : {}),
      ...safeFields(fields),
    } as SkyOsLogEntry;
    writer(JSON.stringify(entry), severity);
    return entry;
  }

  return Object.freeze({
    debug: (fields: SkyOsLogFields) => write('DEBUG', fields),
    info: (fields: SkyOsLogFields) => write('INFO', fields),
    notice: (fields: SkyOsLogFields) => write('NOTICE', fields),
    warning: (fields: SkyOsLogFields) => write('WARNING', fields),
    error: (fields: SkyOsLogFields) => write('ERROR', fields),
    critical: (fields: SkyOsLogFields) => write('CRITICAL', fields),
  });
}
