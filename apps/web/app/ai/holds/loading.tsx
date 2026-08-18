import { LoadingState } from '@/components/ui/loading-state';

export default function AiBudgetHoldsLoading() {
  return <LoadingState label="Loading persisted budget hold evidence" rows={3} />;
}
