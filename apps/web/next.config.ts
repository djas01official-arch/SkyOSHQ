import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import type { NextConfig } from 'next';

// Next runs this workspace from apps/web; SkyOS keeps local configuration at the monorepo root.
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

function getAttachmentBodySizeLimit(): number {
  const value = process.env.KNOWLEDGE_MAX_FILE_SIZE_BYTES?.trim() || `${10 * 1024 * 1024}`;
  if (!/^\d+$/.test(value)) {
    throw new Error('KNOWLEDGE_MAX_FILE_SIZE_BYTES must be a positive integer.');
  }

  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 100 * 1024 * 1024) {
    throw new Error('KNOWLEDGE_MAX_FILE_SIZE_BYTES must be between 1 and 104857600.');
  }

  return size + 1024 * 1024;
}

const nextConfig: NextConfig = {
  transpilePackages: ['@skyos/domain'],
  experimental: {
    serverActions: {
      bodySizeLimit: getAttachmentBodySizeLimit(),
    },
  },
  serverExternalPackages: ['argon2', 'mammoth', 'pdf-parse'],
};

export default nextConfig;
