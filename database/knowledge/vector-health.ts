import type { PrismaClient } from '../generated/client/client';

export class PgvectorUnavailableError extends Error {}

export async function assertPgvectorAvailable(prisma: PrismaClient): Promise<string> {
  const extension = await prisma.$queryRaw<Array<{ extversion: string }>>`
    SELECT extversion
    FROM pg_extension
    WHERE extname = 'vector'
  `;
  const version = extension[0]?.extversion;
  if (!version) {
    throw new PgvectorUnavailableError(
      'The PostgreSQL vector extension is unavailable. Use the documented pgvector database image and run migrations.',
    );
  }
  const probe = await prisma.$queryRaw<Array<{ distance: number }>>`
    SELECT ('[1,0]'::vector <=> '[1,0]'::vector)::double precision AS distance
  `;
  if (probe[0]?.distance !== 0) {
    throw new PgvectorUnavailableError('The PostgreSQL vector extension failed its cosine probe.');
  }
  return version;
}
