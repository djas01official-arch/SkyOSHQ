import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { encode } from 'next-auth/jwt';

import { PrismaClient, UserStatus, type User } from '../../../database/generated/client/client';
import { runKnowledgeMvpE2eScenario } from './knowledge-mvp.e2e';
import { runTasksMvpE2eScenario } from './tasks-mvp.e2e';
import { runTenantLifecycleE2eScenarios, type LifecycleCookieJar } from './tenant-lifecycle.e2e';

const TEST_FILE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_FILE_DIRECTORY, '..');
const REPOSITORY_ROOT = resolve(WEB_ROOT, '../..');
const rootRequire = createRequire(join(REPOSITORY_ROOT, 'package.json'));
const webRequire = createRequire(join(WEB_ROOT, 'package.json'));
const PRISMA_CLI_PATH = rootRequire.resolve('prisma/build/index.js');
const NEXT_CLI_PATH = webRequire.resolve('next/dist/bin/next');
const SESSION_COOKIE_NAME = 'authjs.session-token';
const EXPECTED_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 60_000;
const TRUSTED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type TestIdentity = Pick<User, 'id'> & {
  email: string;
  password: string;
};

type HttpResult = {
  response: Response;
  setCookies: string[];
};

class CookieJar {
  readonly #cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string) {}

  get(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  set(name: string, value: string): void {
    this.#cookies.set(name, value);
  }

  async request(path: string, init: RequestInit = {}): Promise<HttpResult> {
    const headers = new Headers(init.headers);
    const cookieHeader = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');

    if (cookieHeader) {
      headers.set('Cookie', cookieHeader);
    }

    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: init.redirect ?? 'manual',
    });
    const setCookies = getSetCookieHeaders(response.headers);

    for (const header of setCookies) {
      this.#applySetCookie(header);
    }

    return { response, setCookies };
  }

  #applySetCookie(header: string): void {
    const [pair = '', ...attributes] = header.split(';');
    const separator = pair.indexOf('=');

    if (separator < 1) {
      return;
    }

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    const shouldDelete =
      value.length === 0 ||
      attributes.some((attribute) => attribute.trim().toLowerCase() === 'max-age=0');

    if (shouldDelete) {
      this.#cookies.delete(name);
      return;
    }

    this.#cookies.set(name, value);
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const nodeHeaders = headers as Headers & { getSetCookie?: () => string[] };

  if (!nodeHeaders.getSetCookie) {
    throw new Error('This test requires a Node.js runtime with Headers.getSetCookie().');
  }

  return nodeHeaders.getSetCookie();
}

function getCookieAttribute(header: string, name: string): string | null {
  const expectedName = name.toLowerCase();

  for (const attribute of header.split(';').slice(1)) {
    const trimmed = attribute.trim();
    const separator = trimmed.indexOf('=');
    const attributeName = (separator === -1 ? trimmed : trimmed.slice(0, separator)).toLowerCase();

    if (attributeName === expectedName) {
      return separator === -1 ? '' : trimmed.slice(separator + 1);
    }
  }

  return null;
}

function getAdminDatabaseUrl(): URL {
  const configuredUrl = process.env.AUTH_E2E_DATABASE_ADMIN_URL;

  if (!configuredUrl) {
    throw new Error(
      'AUTH_E2E_DATABASE_ADMIN_URL is required and must target a loopback PostgreSQL postgres database.',
    );
  }

  const url = new URL(configuredUrl);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !TRUSTED_LOOPBACK_HOSTS.has(url.hostname) ||
    url.pathname !== '/postgres' ||
    !url.username ||
    !url.password
  ) {
    throw new Error(
      'AUTH_E2E_DATABASE_ADMIN_URL must use explicit test credentials and target postgres on localhost.',
    );
  }

  url.searchParams.delete('schema');
  return url;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe generated PostgreSQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

async function createDisposableDatabase(adminUrl: URL, databaseName: string): Promise<string> {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: adminUrl.toString() }),
  });

  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.$disconnect();
  }

  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  databaseUrl.searchParams.set('schema', 'public');
  return databaseUrl.toString();
}

async function dropDisposableDatabase(adminUrl: URL, databaseName: string): Promise<void> {
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: adminUrl.toString() }),
  });

  try {
    await admin.$queryRawUnsafe(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      databaseName,
    );
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.$disconnect();
  }
}

function applyMigrations(databaseUrl: string): Promise<void> {
  return runNodeProcess('Prisma migration', PRISMA_CLI_PATH, ['migrate', 'deploy'], {
    DATABASE_URL: databaseUrl,
  });
}

function runNodeProcess(
  label: string,
  entrypoint: string,
  args: string[],
  environment: Record<string, string>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, ...environment },
      stdio: 'inherit',
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} exceeded ${PROCESS_TIMEOUT_MS}ms.`));
    }, PROCESS_TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(
        new Error(`${label} exited with code ${code ?? 'none'} and signal ${signal ?? 'none'}.`),
      );
    });
  });
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate an isolated local port for the Next.js server.'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise(port);
      });
    });
  });
}

function startWebApplication(environment: Record<string, string>): {
  child: ChildProcess;
  getLogs: () => string;
} {
  const child = spawn(
    process.execPath,
    [NEXT_CLI_PATH, 'dev', '--hostname', '127.0.0.1', '--port', environment.PORT ?? '3000'],
    {
      cwd: WEB_ROOT,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let output = '';
  const appendOutput = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-30_000);
  };

  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);

  return { child, getLogs: () => output };
}

async function waitForApplication(
  child: ChildProcess,
  baseUrl: string,
  getLogs: () => string,
): Promise<void> {
  const deadline = Date.now() + PROCESS_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready.\n${getLogs()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/login`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(2_000),
      });

      if (response.status === 200) {
        return;
      }
    } catch {
      // Readiness polling intentionally retries until the bounded deadline.
    }

    await delay(100);
  }

  throw new Error(`Next.js did not become ready within ${PROCESS_TIMEOUT_MS}ms.\n${getLogs()}`);
}

async function stopWebApplication(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  const exited = await new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });

  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

async function createIdentity(
  prisma: PrismaClient,
  label: string,
  password: string,
  passwordHash: string,
): Promise<TestIdentity> {
  const email = `${label}-${randomUUID()}@auth-e2e.skyos.local`;
  const user = await prisma.user.create({
    data: {
      displayName: `Auth E2E ${label}`,
      email,
      emailVerified: new Date(),
      identitySubject: `auth-e2e:${randomUUID()}`,
      passwordHash,
      status: UserStatus.ACTIVE,
    },
  });

  return { email, id: user.id, password };
}

async function getCsrfToken(jar: CookieJar): Promise<string> {
  const { response } = await jar.request('/api/auth/csrf');
  assert.equal(response.status, 200, 'Auth.js CSRF endpoint must be available.');
  const body = (await response.json()) as { csrfToken?: unknown };
  assert.equal(typeof body.csrfToken, 'string', 'Auth.js must return a CSRF token.');
  return body.csrfToken as string;
}

async function loginWithCredentials(
  jar: CookieJar,
  baseUrl: string,
  identity: Pick<TestIdentity, 'email' | 'password'>,
  callbackPath = '/dashboard',
): Promise<HttpResult> {
  const csrfToken = await getCsrfToken(jar);
  const body = new URLSearchParams({
    callbackUrl: callbackPath,
    csrfToken,
    email: identity.email,
    password: identity.password,
  });

  return jar.request('/api/auth/callback/credentials', {
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl,
    },
    method: 'POST',
  });
}

async function logout(jar: CookieJar, baseUrl: string): Promise<HttpResult> {
  const csrfToken = await getCsrfToken(jar);
  const body = new URLSearchParams({
    callbackUrl: '/login',
    csrfToken,
  });

  return jar.request('/api/auth/signout', {
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl,
    },
    method: 'POST',
  });
}

function assertEquivalentLoopbackOrigin(actualUrl: URL, expectedBaseUrl: string): void {
  const expectedUrl = new URL(expectedBaseUrl);

  assert.ok(
    TRUSTED_LOOPBACK_HOSTS.has(actualUrl.hostname),
    `Redirect host must be trusted loopback; received ${actualUrl.hostname}.`,
  );
  assert.ok(
    TRUSTED_LOOPBACK_HOSTS.has(expectedUrl.hostname),
    `Test base host must be trusted loopback; received ${expectedUrl.hostname}.`,
  );
  assert.equal(
    actualUrl.protocol,
    expectedUrl.protocol,
    'Redirect protocol must remain unchanged.',
  );
  assert.equal(actualUrl.port, expectedUrl.port, 'Redirect must remain on the test server port.');
  assert.equal(actualUrl.username, '', 'Redirect URL must not contain a username.');
  assert.equal(actualUrl.password, '', 'Redirect URL must not contain a password.');
}

function getTrustedRedirectUrl(response: Response, baseUrl: string): URL {
  assert.ok(
    [302, 303, 307, 308].includes(response.status),
    `Expected redirect, got ${response.status}.`,
  );
  const location = response.headers.get('location');
  assert.ok(location, 'Redirect response must include a Location header.');
  const redirectUrl = new URL(location, baseUrl);
  assertEquivalentLoopbackOrigin(redirectUrl, baseUrl);
  return redirectUrl;
}

function assertRedirectsTo(response: Response, baseUrl: string, pathname: string): URL {
  const redirectUrl = getTrustedRedirectUrl(response, baseUrl);
  assert.equal(redirectUrl.pathname, pathname);
  return redirectUrl;
}

async function assertProtectedRouteDenied(
  jar: CookieJar,
  baseUrl: string,
  pathname = '/dashboard',
): Promise<void> {
  const { response } = await jar.request(pathname);
  const redirectUrl = assertRedirectsTo(response, baseUrl, '/login');
  const callbackUrlValue = redirectUrl.searchParams.get('callbackUrl');
  assert.ok(callbackUrlValue, 'Protected-route redirect must preserve its callback URL.');
  const callbackUrl = new URL(callbackUrlValue);
  assertEquivalentLoopbackOrigin(callbackUrl, baseUrl);
  assert.equal(callbackUrl.pathname, pathname);
  assert.equal(callbackUrl.search, '');
  assert.equal(callbackUrl.hash, '');
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

async function getRenderedLoginRedirect(baseUrl: string, callbackUrl: string): Promise<string> {
  const url = new URL('/login', baseUrl);
  url.searchParams.set('callbackUrl', callbackUrl);
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const html = await response.text();
  const input = html.match(/<input(?=[^>]*\bname="redirectTo")[^>]*>/)?.[0];
  assert.ok(input, 'Login page must render the trusted redirect as a hidden input.');
  const value = input.match(/\bvalue="([^"]*)"/)?.[1];
  assert.notEqual(value, undefined, 'Login redirect input must have a value.');
  return decodeHtmlAttribute(value ?? '');
}

test(
  'SkyOS authentication, tenant lifecycle, Knowledge, and Tasks MVPs work through real HTTP requests and disposable PostgreSQL',
  { timeout: 240_000 },
  async (context) => {
    const adminUrl = getAdminDatabaseUrl();
    const databaseName = `skyos_auth_e2e_${process.pid}_${randomBytes(4).toString('hex')}`;
    const authSecret = randomBytes(32).toString('base64url');
    const password = `auth-e2e-${randomBytes(18).toString('base64url')}`;
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const storageRoot = await mkdtemp(join(tmpdir(), 'skyos-auth-e2e-'));
    const nextDistDir = `temp/auth-e2e-${process.pid}-${randomBytes(4).toString('hex')}`;
    let databaseCreated = false;
    let prisma: PrismaClient | undefined;
    let webProcess: ChildProcess | undefined;
    let getWebLogs: (() => string) | undefined;

    try {
      const databaseUrl = await createDisposableDatabase(adminUrl, databaseName);
      databaseCreated = true;
      await applyMigrations(databaseUrl);
      prisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString: databaseUrl }),
      });

      const port = await getAvailablePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const started = startWebApplication({
        AI_PROVIDER: 'local',
        AUTH_SECRET: authSecret,
        AUTH_TRUST_HOST: 'true',
        AUTH_URL: baseUrl,
        BACKGROUND_JOB_MODE: 'synchronous',
        DATABASE_URL: databaseUrl,
        EMBEDDING_PROVIDER: 'local',
        KNOWLEDGE_STORAGE_ROOT: storageRoot,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_ENV: 'development',
        PORT: String(port),
        SKYOS_NEXT_DIST_DIR: nextDistDir,
      });
      webProcess = started.child;
      getWebLogs = started.getLogs;
      await waitForApplication(webProcess, baseUrl, getWebLogs);

      await context.test('unauthenticated product access redirects to login', async () => {
        await assertProtectedRouteDenied(new CookieJar(baseUrl), baseUrl);
      });

      await context.test(
        'valid login persists, exposes secure cookie attributes, and logs out',
        async () => {
          const identity = await createIdentity(prisma!, 'valid', password, passwordHash);
          const jar = new CookieJar(baseUrl);
          const loginResult = await loginWithCredentials(jar, baseUrl, identity);
          assertRedirectsTo(loginResult.response, baseUrl, '/dashboard');

          const sessionSetCookie = loginResult.setCookies.find((header) =>
            header.startsWith(`${SESSION_COOKIE_NAME}=`),
          );
          assert.ok(sessionSetCookie, 'Successful login must set the Auth.js session cookie.');
          assert.notEqual(jar.get(SESSION_COOKIE_NAME), undefined);
          assert.notEqual(getCookieAttribute(sessionSetCookie, 'httponly'), null);
          assert.equal(getCookieAttribute(sessionSetCookie, 'samesite')?.toLowerCase(), 'lax');
          assert.equal(getCookieAttribute(sessionSetCookie, 'path'), '/');
          assert.equal(getCookieAttribute(sessionSetCookie, 'secure'), null);

          const expires = getCookieAttribute(sessionSetCookie, 'expires');
          assert.ok(expires, 'Session cookie must carry an explicit expiry.');
          const lifetime = Date.parse(expires) - Date.now();
          assert.ok(
            lifetime > EXPECTED_SESSION_LIFETIME_MS - 5 * 60_000 &&
              lifetime < EXPECTED_SESSION_LIFETIME_MS + 5 * 60_000,
            `Session cookie expiry must be approximately eight hours; received ${lifetime}ms.`,
          );

          const firstDashboard = await jar.request('/dashboard');
          assert.equal(firstDashboard.response.status, 200);
          const secondDashboard = await jar.request('/dashboard');
          assert.equal(secondDashboard.response.status, 200);

          const sessionResponse = await jar.request('/api/auth/session');
          assert.equal(sessionResponse.response.status, 200);
          const session = (await sessionResponse.response.json()) as { user?: { id?: unknown } };
          assert.equal(session.user?.id, identity.id);

          const logoutResult = await logout(jar, baseUrl);
          assertRedirectsTo(logoutResult.response, baseUrl, '/login');
          const deletionCookie = logoutResult.setCookies.find((header) =>
            header.startsWith(`${SESSION_COOKIE_NAME}=`),
          );
          assert.ok(deletionCookie, 'Logout must expire the active session cookie.');
          assert.equal(getCookieAttribute(deletionCookie, 'max-age'), '0');
          assert.equal(jar.get(SESSION_COOKIE_NAME), undefined);
          await assertProtectedRouteDenied(jar, baseUrl);
        },
      );

      await context.test('invalid password and unknown identity fail identically', async () => {
        const identity = await createIdentity(prisma!, 'invalid', password, passwordHash);
        const wrongPassword = await loginWithCredentials(new CookieJar(baseUrl), baseUrl, {
          email: identity.email,
          password: `${password}-wrong`,
        });
        const unknownIdentity = await loginWithCredentials(new CookieJar(baseUrl), baseUrl, {
          email: `unknown-${randomUUID()}@auth-e2e.skyos.local`,
          password,
        });
        const wrongPasswordUrl = assertRedirectsTo(wrongPassword.response, baseUrl, '/login');
        const unknownIdentityUrl = assertRedirectsTo(unknownIdentity.response, baseUrl, '/login');

        assert.equal(wrongPasswordUrl.search, unknownIdentityUrl.search);
        assert.equal(wrongPasswordUrl.searchParams.get('error'), 'CredentialsSignin');
        assert.equal(wrongPasswordUrl.searchParams.get('code'), 'credentials');
        assert.equal(wrongPasswordUrl.toString().includes(identity.email), false);
        assert.equal(
          wrongPassword.setCookies.some((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)),
          false,
        );
        assert.equal(
          unknownIdentity.setCookies.some((header) => header.startsWith(`${SESSION_COOKIE_NAME}=`)),
          false,
        );
      });

      await context.test('suspended users lose product access on their next request', async () => {
        const identity = await createIdentity(prisma!, 'suspended', password, passwordHash);
        const jar = new CookieJar(baseUrl);
        assertRedirectsTo(
          (await loginWithCredentials(jar, baseUrl, identity)).response,
          baseUrl,
          '/dashboard',
        );
        await prisma!.user.update({
          where: { id: identity.id },
          data: { status: UserStatus.SUSPENDED },
        });
        await assertProtectedRouteDenied(jar, baseUrl);
      });

      await context.test('deactivated users cannot retain effective product access', async () => {
        const identity = await createIdentity(prisma!, 'deactivated', password, passwordHash);
        const jar = new CookieJar(baseUrl);
        assertRedirectsTo(
          (await loginWithCredentials(jar, baseUrl, identity)).response,
          baseUrl,
          '/dashboard',
        );
        await prisma!.user.update({
          where: { id: identity.id },
          data: { status: UserStatus.DEACTIVATED },
        });
        await assertProtectedRouteDenied(jar, baseUrl);
      });

      await context.test('login renders only safe local callback destinations', async () => {
        assert.equal(
          await getRenderedLoginRedirect(baseUrl, '/settings?source=auth&mode=e2e'),
          '/settings?source=auth&mode=e2e',
        );

        for (const unsafeRedirect of [
          'https://attacker.example/collect',
          'javascript:alert(1)',
          'data:text/html,<script>alert(1)</script>',
          '//attacker.example/collect',
          '/\\attacker.example/collect',
          '/%5c%5cattacker.example/collect',
          '/dashboard%00',
          '/dashboard%0d%0aLocation:https://attacker.example',
          '/login',
          '/login/again',
        ]) {
          assert.equal(await getRenderedLoginRedirect(baseUrl, unsafeRedirect), '/dashboard');
        }

        const identity = await createIdentity(prisma!, 'redirect', password, passwordHash);
        const jar = new CookieJar(baseUrl);
        const loginResult = await loginWithCredentials(
          jar,
          baseUrl,
          identity,
          '/settings?source=auth&mode=e2e',
        );
        const safeCallbackUrl = assertRedirectsTo(loginResult.response, baseUrl, '/settings');
        assert.equal(safeCallbackUrl.search, '?source=auth&mode=e2e');
        assert.equal((await jar.request('/settings')).response.status, 200);
      });

      await context.test(
        'forged and expired JWT cookies are rejected without sleeping',
        async () => {
          const identity = await createIdentity(prisma!, 'expired', password, passwordHash);
          const forgedJar = new CookieJar(baseUrl);
          forgedJar.set(SESSION_COOKIE_NAME, 'not-a-valid-authjs-token');
          await assertProtectedRouteDenied(forgedJar, baseUrl);

          const expiredToken = await encode({
            maxAge: -60,
            salt: SESSION_COOKIE_NAME,
            secret: authSecret,
            token: {
              email: identity.email,
              sub: identity.id,
            },
          });
          const expiredJar = new CookieJar(baseUrl);
          expiredJar.set(SESSION_COOKIE_NAME, expiredToken);
          await assertProtectedRouteDenied(expiredJar, baseUrl);
        },
      );

      await runTenantLifecycleE2eScenarios(context, {
        assertProtectedRouteDenied: async (jar: LifecycleCookieJar, pathname: string) => {
          assert.ok(jar instanceof CookieJar);
          await assertProtectedRouteDenied(jar, baseUrl, pathname);
        },
        assertRedirectsTo: (response: Response, pathname: string) =>
          assertRedirectsTo(response, baseUrl, pathname),
        baseUrl,
        createIdentity: (label: string) => createIdentity(prisma!, label, password, passwordHash),
        createJar: () => new CookieJar(baseUrl),
        login: async (jar: LifecycleCookieJar, identity) => {
          assert.ok(jar instanceof CookieJar);
          return (await loginWithCredentials(jar, baseUrl, identity, '/settings')).response;
        },
        prisma,
      });

      await runKnowledgeMvpE2eScenario(context, {
        assertRedirectsTo: (response: Response, pathname: string) =>
          assertRedirectsTo(response, baseUrl, pathname),
        baseUrl,
        createIdentity: (label: string) => createIdentity(prisma!, label, password, passwordHash),
        createJar: () => new CookieJar(baseUrl),
        getRedirectUrl: (response: Response) => getTrustedRedirectUrl(response, baseUrl),
        login: async (jar, identity) => {
          assert.ok(jar instanceof CookieJar);
          return (await loginWithCredentials(jar, baseUrl, identity, '/knowledge')).response;
        },
        prisma,
      });

      await runTasksMvpE2eScenario(context, {
        assertRedirectsTo: (response: Response, pathname: string) =>
          assertRedirectsTo(response, baseUrl, pathname),
        baseUrl,
        createIdentity: (label: string) => createIdentity(prisma!, label, password, passwordHash),
        createJar: () => new CookieJar(baseUrl),
        getRedirectUrl: (response: Response) => getTrustedRedirectUrl(response, baseUrl),
        login: async (jar, identity) => {
          assert.ok(jar instanceof CookieJar);
          return (await loginWithCredentials(jar, baseUrl, identity, '/tasks')).response;
        },
        prisma,
      });
    } catch (error) {
      if (getWebLogs) {
        context.diagnostic(`Next.js output:\n${getWebLogs()}`);
      }

      throw error;
    } finally {
      if (webProcess) {
        await stopWebApplication(webProcess);
      }

      if (prisma) {
        await prisma.$disconnect();
      }

      if (databaseCreated) {
        await dropDisposableDatabase(adminUrl, databaseName);
      }

      await rm(storageRoot, { force: true, recursive: true });
      await rm(resolve(WEB_ROOT, nextDistDir), { force: true, recursive: true });
    }
  },
);
