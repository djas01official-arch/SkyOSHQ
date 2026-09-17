import type { BackgroundJobReconciliationReport } from './reconciliation';

const ACTIONABLE_DRIFT_FIELDS = [
  'queuedNeverStarted',
  'expiredProcessingLeases',
  'attachmentsWithoutBinaries',
  'binariesWithoutMetadata',
  'incompleteExtractions',
  'incompleteChunkSets',
  'incompleteEmbeddingSets',
  'unprocessedAttachments',
  'unchunkedExtractions',
  'unembeddedChunkSets',
  'attachmentMetadataMismatches',
  'orphanChunks',
  'orphanEmbeddings',
] as const satisfies readonly (keyof BackgroundJobReconciliationReport)[];

export function summarizeBackgroundJobReconciliation(
  report: BackgroundJobReconciliationReport,
): Readonly<{ driftCount: number; failedBackgroundJobCount: number }> {
  return Object.freeze({
    driftCount: ACTIONABLE_DRIFT_FIELDS.reduce((total, field) => total + report[field].length, 0),
    failedBackgroundJobCount: report.failedBackgroundJobs.length,
  });
}
