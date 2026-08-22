import { readinessHealthResponse } from '@/lib/health';

export async function GET(): Promise<Response> {
  return readinessHealthResponse(async () => {
    const { prisma } = await import('@/lib/prisma');
    await prisma.$queryRaw`SELECT 1`;
  });
}
