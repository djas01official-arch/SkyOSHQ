import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../../../database/generated/client/client';

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

let productionPrisma: PrismaClient | undefined;

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL is required for SkyOS authentication.');
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
}

export function getPrisma(): PrismaClient {
  const cached = process.env.NODE_ENV === 'production' ? productionPrisma : globalForPrisma.prisma;
  if (cached) {
    return cached;
  }

  const client = createPrismaClient();

  if (process.env.NODE_ENV === 'production') {
    productionPrisma = client;
  } else {
    globalForPrisma.prisma = client;
  }

  return client;
}

/**
 * Defers database configuration validation until a server request actually
 * needs Prisma. This keeps production image builds free of runtime secrets.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(getPrisma(), property, receiver);
    return typeof value === 'function' ? value.bind(getPrisma()) : value;
  },
});
