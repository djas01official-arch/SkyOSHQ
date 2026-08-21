import { isIP } from 'node:net';
import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import type { NextConfig } from 'next';

// The root dev launcher establishes the canonical local child environment. This non-overriding
// load remains a fallback when the web workspace is run directly.
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;

function isAllowedDevOriginHostname(value: string): boolean {
  if (/^[0-9.]+$/u.test(value) || value.length > 253) return false;
  return HOSTNAME_PATTERN.test(value);
}

function isAllowedDevOriginHost(value: string): boolean {
  return isIP(value) === 4 || isAllowedDevOriginHostname(value);
}

/**
 * Parses host identifiers accepted by Next.js `allowedDevOrigins`. This is
 * deliberately not a URL parser: ports, paths, protocols, and userinfo do
 * not belong in Next's development hostname allowlist.
 */
export function parseSkyosDevAllowedOrigins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('SKYOS_DEV_ALLOWED_ORIGINS must be a comma-separated list of hostnames.');
  }

  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(',')) {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;

    const wildcardSuffix = normalized.startsWith('*.') ? normalized.slice(2) : undefined;
    const isBoundedWildcard =
      wildcardSuffix !== undefined &&
      wildcardSuffix.includes('.') &&
      isAllowedDevOriginHostname(wildcardSuffix);
    if (!isAllowedDevOriginHost(normalized) && !isBoundedWildcard) {
      throw new Error('SKYOS_DEV_ALLOWED_ORIGINS contains an invalid hostname.');
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      origins.push(normalized);
    }
  }

  return origins.length > 0 ? origins : undefined;
}

export function getSkyosDevAllowedOrigins(
  environment: string | undefined,
  value = process.env.SKYOS_DEV_ALLOWED_ORIGINS,
): string[] | undefined {
  return environment === 'development' ? parseSkyosDevAllowedOrigins(value) : undefined;
}

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

function getTestBuildDirectory(): string | undefined {
  const value = process.env.SKYOS_NEXT_DIST_DIR?.trim();

  if (!value) {
    return undefined;
  }

  if (!/^temp\/auth-e2e-[a-z0-9_-]+$/.test(value)) {
    throw new Error('SKYOS_NEXT_DIST_DIR must be a generated auth E2E directory under temp/.');
  }

  return value;
}

export function createSkyosNextConfig(
  environment = process.env.NODE_ENV,
  allowedOrigins = process.env.SKYOS_DEV_ALLOWED_ORIGINS,
): NextConfig {
  const allowedDevOrigins = getSkyosDevAllowedOrigins(environment, allowedOrigins);
  return {
    ...(allowedDevOrigins ? { allowedDevOrigins } : {}),
    distDir: getTestBuildDirectory(),
    transpilePackages: ['@skyos/domain'],
    experimental: {
      serverActions: {
        bodySizeLimit: getAttachmentBodySizeLimit(),
      },
    },
    serverExternalPackages: ['argon2', 'mammoth', 'pdf-parse'],
  };
}

const nextConfig = createSkyosNextConfig();

export default nextConfig;
