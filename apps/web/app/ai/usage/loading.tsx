import { LoadingState } from '@/components/ui/loading-state';

export default function AiUsageLoading() {
  return <LoadingState className="mx-auto max-w-7xl" label="Loading AI usage and cost" rows={8} />;
}
