import { liveHealthResponse } from '@/lib/health';

export function GET(): Response {
  return liveHealthResponse();
}
