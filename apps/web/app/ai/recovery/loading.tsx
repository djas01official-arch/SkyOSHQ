import { LoadingState } from '@/components/ui/loading-state';

export default function AiExecutionRecoveryLoading() {
  return <LoadingState label="Loading persisted execution recovery evidence" rows={3} />;
}
