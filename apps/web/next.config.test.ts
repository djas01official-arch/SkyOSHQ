import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSkyosNextConfig,
  getSkyosDevAllowedOrigins,
  getSkyosProductionSecurityHeaders,
  parseSkyosDevAllowedOrigins,
} from './next.config';

test('parses absent, blank, and whitespace-only development origin configuration as unset', () => {
  for (const value of [undefined, '', '   ', ' , , ']) {
    assert.equal(parseSkyosDevAllowedOrigins(value), undefined);
  }
});

test('parses hostname and IPv4 development origins in stable order', () => {
  assert.deepEqual(parseSkyosDevAllowedOrigins('my-dev-host.local,203.0.113.12'), [
    'my-dev-host.local',
    '203.0.113.12',
  ]);
});

test('trims and deterministically deduplicates development origin hostnames', () => {
  assert.deepEqual(
    parseSkyosDevAllowedOrigins(' My-Dev-Host.Local ,*.example.local,my-dev-host.local '),
    ['my-dev-host.local', '*.example.local'],
  );
});

test('allows only bounded wildcard hostnames', () => {
  assert.deepEqual(parseSkyosDevAllowedOrigins('*.example.local'), ['*.example.local']);
  for (const value of ['*', '*.local', '*.203.0.113.12', '**.example.local']) {
    assert.throws(() => parseSkyosDevAllowedOrigins(value));
  }
});

test('rejects malformed development origins rather than repairing URLs or host syntax', () => {
  for (const value of [
    'https://example.local',
    'example.local/path',
    'example.local?query=value',
    'example.local#fragment',
    'user@example.local',
    'example .local',
    'example.local:3000',
    '999.999.999.999',
  ]) {
    assert.throws(() => parseSkyosDevAllowedOrigins(value));
  }
});

test('allows additional origins only in development', () => {
  assert.deepEqual(getSkyosDevAllowedOrigins('development', 'my-dev-host.local'), [
    'my-dev-host.local',
  ]);
  assert.equal(getSkyosDevAllowedOrigins('production', 'my-dev-host.local'), undefined);
  assert.equal(getSkyosDevAllowedOrigins(undefined, 'my-dev-host.local'), undefined);
});

test('adds the production security-header baseline only in production', async () => {
  assert.equal(getSkyosProductionSecurityHeaders('development'), undefined);
  assert.equal(getSkyosProductionSecurityHeaders('test'), undefined);
  assert.equal(getSkyosProductionSecurityHeaders(undefined), undefined);

  const headers = getSkyosProductionSecurityHeaders('production');
  assert.ok(headers);
  const values = new Map(headers.map(({ key, value }) => [key, value]));
  assert.equal(values.get('Strict-Transport-Security'), 'max-age=31536000; includeSubDomains');
  assert.equal(values.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(values.get('X-Frame-Options'), 'DENY');
  assert.equal(values.get('Referrer-Policy'), 'no-referrer');
  assert.equal(
    values.get('Permissions-Policy'),
    'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  );
  assert.equal(values.get('X-Permitted-Cross-Domain-Policies'), 'none');
  const csp = values.get('Content-Security-Policy');
  assert.ok(csp);
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "connect-src 'self'",
    'upgrade-insecure-requests',
  ]) {
    assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const production = createSkyosNextConfig('production');
  assert.equal(typeof production.headers, 'function');
  const routes = await production.headers!();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]?.source, '/:path*');
  assert.deepEqual(routes[0]?.headers, headers);

  const development = createSkyosNextConfig('development');
  assert.equal(development.headers, undefined);
});

test('keeps existing Next configuration values intact', () => {
  const development = createSkyosNextConfig('development', 'my-dev-host.local');
  const production = createSkyosNextConfig('production', 'my-dev-host.local');

  assert.deepEqual(development.allowedDevOrigins, ['my-dev-host.local']);
  assert.equal(production.allowedDevOrigins, undefined);
  for (const config of [development, production]) {
    assert.equal(config.distDir, undefined);
    assert.equal(config.output, 'standalone');
    assert.deepEqual(config.transpilePackages, ['@skyos/domain']);
    assert.equal(config.experimental?.serverActions?.bodySizeLimit, 11 * 1024 * 1024);
    assert.deepEqual(config.serverExternalPackages, [
      '@google-cloud/storage',
      'argon2',
      'mammoth',
      'pdf-parse',
    ]);
  }
});
