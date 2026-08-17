'use client';

import { EmptyState } from '@/components/ui/empty-state';

export default function AiExecutionRecoveryError() {
  return (
    <EmptyState
      description="Recovery inspection data could not be loaded. Refresh the page to inspect persisted evidence again."
      icon="activity"
      title="Recovery inspection unavailable"
    />
  );
}
