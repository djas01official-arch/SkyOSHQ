'use client';

import { EmptyState } from '@/components/ui/empty-state';

export default function AiBudgetHoldsError() {
  return (
    <EmptyState
      description="Budget hold evidence could not be loaded. Refresh the page to inspect persisted evidence again."
      icon="activity"
      title="Budget hold inspection unavailable"
    />
  );
}
