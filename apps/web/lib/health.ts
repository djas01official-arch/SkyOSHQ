export const DEFAULT_DATABASE_READINESS_TIMEOUT_MS = 1_000;

export type DatabaseReadinessCheck = () => Promise<void>;

export function liveHealthResponse(): Response {
  return Response.json({ status: 'ok' });
}

async function runWithTimeout(
  operation: DatabaseReadinessCheck,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error(
      'Health readiness timeout must be an integer between 1 and 10000 milliseconds.',
    );
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Database readiness timed out.')), timeoutMs);
        timeout.unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function readinessHealthResponse(
  check: DatabaseReadinessCheck,
  timeoutMs = DEFAULT_DATABASE_READINESS_TIMEOUT_MS,
): Promise<Response> {
  const ready = await runWithTimeout(check, timeoutMs);
  return ready
    ? Response.json({ status: 'ok' })
    : Response.json({ status: 'unavailable' }, { status: 503 });
}
