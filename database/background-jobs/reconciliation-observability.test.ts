import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeBackgroundJobReconciliation } from './reconciliation-observability';
import type { BackgroundJobReconciliationReport } from './reconciliation';

function emptyReport(): BackgroundJobReconciliationReport {
  return {
    archivedAttachments: [],
    attachmentMetadataMismatches: [],
    attachmentsWithoutBinaries: [],
    binariesWithoutMetadata: [],
    expiredProcessingLeases: [],
    failedBackgroundJobs: [],
    incompleteChunkSets: [],
    incompleteEmbeddingSets: [],
    incompleteExtractions: [],
    orphanChunks: [],
    orphanEmbeddings: [],
    queuedNeverStarted: [],
    unchunkedExtractions: [],
    unembeddedChunkSets: [],
    unprocessedAttachments: [],
  };
}

test('clean and archived lifecycle state does not create actionable drift', () => {
  const report = emptyReport();
  report.archivedAttachments.push('archived-id');
  assert.deepEqual(summarizeBackgroundJobReconciliation(report), {
    driftCount: 0,
    failedBackgroundJobCount: 0,
  });
});

test('actionable findings are counted without exposing identifiers', () => {
  const report = emptyReport();
  report.attachmentsWithoutBinaries.push('attachment-id');
  report.queuedNeverStarted.push('job-1', 'job-2');
  report.failedBackgroundJobs.push('historical-failure');
  assert.deepEqual(summarizeBackgroundJobReconciliation(report), {
    driftCount: 3,
    failedBackgroundJobCount: 1,
  });
});
