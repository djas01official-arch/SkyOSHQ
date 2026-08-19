const GOOGLE_VERTEX_BILLING_LABEL_KEY = 'skyos_run';
const GOOGLE_VERTEX_BILLING_LABEL_VALUE_PREFIX = 'run-';
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GOOGLE_VERTEX_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/u;
const GOOGLE_VERTEX_LABEL_VALUE_PATTERN = /^[a-z0-9_-]{1,63}$/u;

export type GoogleVertexBillingCorrelation = Readonly<{
  labelKey: typeof GOOGLE_VERTEX_BILLING_LABEL_KEY;
  labelValue: string;
}>;

/**
 * Produces the one opaque Vertex request label SkyOS may use after a separate
 * approved migration to Vertex AI GenerateContent. It is a lossless encoding
 * of the existing AiRun UUID, not a provider request ID or financial record.
 */
export function createGoogleVertexBillingCorrelation(
  aiRunId: string,
): GoogleVertexBillingCorrelation {
  if (!CANONICAL_UUID_PATTERN.test(aiRunId)) {
    throw new Error('A canonical AiRun UUID is required for Vertex billing correlation.');
  }
  const labelValue = `${GOOGLE_VERTEX_BILLING_LABEL_VALUE_PREFIX}${aiRunId}`;
  if (
    !GOOGLE_VERTEX_LABEL_PATTERN.test(GOOGLE_VERTEX_BILLING_LABEL_KEY) ||
    !GOOGLE_VERTEX_LABEL_VALUE_PATTERN.test(labelValue)
  ) {
    throw new Error('The Vertex billing correlation label does not meet label constraints.');
  }
  return Object.freeze({ labelKey: GOOGLE_VERTEX_BILLING_LABEL_KEY, labelValue });
}

/**
 * Losslessly recovers the canonical SkyOS AiRun identity from the technical
 * label. The caller must still resolve the run authoritatively; this parser
 * never creates, updates, or otherwise establishes a run identity.
 */
export function parseGoogleVertexBillingCorrelation(labelValue: string): string | undefined {
  if (!GOOGLE_VERTEX_LABEL_VALUE_PATTERN.test(labelValue)) return undefined;
  const aiRunId = labelValue.slice(GOOGLE_VERTEX_BILLING_LABEL_VALUE_PREFIX.length);
  return CANONICAL_UUID_PATTERN.test(aiRunId) ? aiRunId : undefined;
}
