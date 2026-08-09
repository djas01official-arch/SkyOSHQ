import 'dotenv/config';

import process from 'node:process';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/client/client';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to check database indexes.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

type UncoveredForeignKey = Readonly<{
  foreignKey: string;
  tableName: string;
}>;

type DuplicateIndexes = Readonly<{
  indexes: string[];
  tableName: string;
}>;

async function main(): Promise<void> {
  const uncovered = await prisma.$queryRaw<UncoveredForeignKey[]>`
    SELECT
      constraint_definition.conname AS "foreignKey",
      constraint_definition.conrelid::regclass::text AS "tableName"
    FROM pg_constraint AS constraint_definition
    WHERE constraint_definition.contype = 'f'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_index AS index_definition
        WHERE index_definition.indrelid = constraint_definition.conrelid
          AND index_definition.indisvalid
          AND index_definition.indisready
          AND index_definition.indpred IS NULL
          AND (index_definition.indkey::smallint[])[0] = constraint_definition.conkey[1]
      )
    ORDER BY "tableName", "foreignKey"
  `;

  if (uncovered.length > 0) {
    const details = uncovered.map(({ foreignKey, tableName }) => `${tableName}.${foreignKey}`);
    throw new Error(`Foreign keys without a usable leading-column index: ${details.join(', ')}`);
  }

  const duplicates = await prisma.$queryRaw<DuplicateIndexes[]>`
    SELECT
      array_agg(indexrelid::regclass::text ORDER BY indexrelid::regclass::text) AS indexes,
      indrelid::regclass::text AS "tableName"
    FROM pg_index
    WHERE indisvalid AND indisready
    GROUP BY indrelid, indkey, indclass, indcollation, indexprs, indpred
    HAVING count(*) > 1
    ORDER BY "tableName"
  `;

  if (duplicates.length > 0) {
    const details = duplicates.map(
      ({ indexes, tableName }) => `${tableName} (${indexes.join(', ')})`,
    );
    throw new Error(`Exact duplicate index definitions: ${details.join('; ')}`);
  }

  console.log('Database index check passed.');
}

main()
  .catch((error: unknown) => {
    console.error('Database index check failed.', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
