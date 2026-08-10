import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';

import { AuditAction } from '../../../database/audit/audit-event';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
  type PrismaClient,
  UserStatus,
  WorkspaceRole,
  WorkspaceStatus,
} from '../../../database/generated/client/client';

type TestIdentity = {
  email: string;
  id: string;
  password: string;
};

type HttpResult = {
  response: Response;
  setCookies: string[];
};

export type LifecycleCookieJar = {
  request(path: string, init?: RequestInit): Promise<HttpResult>;
};

export type TenantLifecycleE2eHarness = {
  assertProtectedRouteDenied(jar: LifecycleCookieJar, pathname: string): Promise<void>;
  assertRedirectsTo(response: Response, pathname: string): URL;
  baseUrl: string;
  createIdentity(label: string): Promise<TestIdentity>;
  createJar(): LifecycleCookieJar;
  login(jar: LifecycleCookieJar, identity: TestIdentity): Promise<Response>;
  prisma: PrismaClient;
};

type ParsedLifecycleForm = {
  fields: Array<readonly [string, string]>;
  operation: string;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

  for (const match of tag.matchAll(pattern)) {
    const [, name = '', doubleQuoted, singleQuoted, unquoted] = match;
    if (name === 'form' || name === 'input') continue;
    attributes.set(name, decodeHtml(doubleQuoted ?? singleQuoted ?? unquoted ?? ''));
  }

  return attributes;
}

function findLifecycleForm(
  html: string,
  operation: string,
  fieldName: string,
  targetId: string,
): ParsedLifecycleForm {
  const forms = html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gu);

  for (const form of forms) {
    const formAttributes = parseAttributes(`form ${form[1] ?? ''}`);
    if (formAttributes.get('data-lifecycle-operation') !== operation) continue;

    const fields: Array<readonly [string, string]> = [];
    for (const input of (form[2] ?? '').matchAll(/<input\b([^>]*)>/gu)) {
      const attributes = parseAttributes(`input ${input[1] ?? ''}`);
      const name = attributes.get('name');
      if (name) fields.push([name, attributes.get('value') ?? '']);
    }

    if (fields.some(([name, value]) => name === fieldName && value === targetId)) {
      assert.ok(
        fields.some(([name]) => name.startsWith('$ACTION_')),
        'Rendered lifecycle form must contain React server-action metadata.',
      );
      return { fields, operation };
    }
  }

  throw new Error(`Unable to find ${operation} form for ${targetId}.`);
}

async function loadSettings(jar: LifecycleCookieJar): Promise<string> {
  const { response } = await jar.request('/settings');
  assert.equal(response.status, 200, 'Authenticated Settings request must succeed.');
  return response.text();
}

async function submitLifecycleForm(
  jar: LifecycleCookieJar,
  baseUrl: string,
  html: string,
  operation: string,
  fieldName: string,
  renderedTargetId: string,
  submittedTargetId = renderedTargetId,
): Promise<Response> {
  const form = findLifecycleForm(html, operation, fieldName, renderedTargetId);
  const body = new FormData();

  for (const [name, value] of form.fields) {
    body.append(name, name === fieldName ? submittedTargetId : value);
  }

  const { response } = await jar.request('/settings', {
    body,
    headers: { Origin: baseUrl },
    method: 'POST',
  });
  return response;
}

async function readSession(jar: LifecycleCookieJar): Promise<{
  activeOrganizationId: string | null;
  activeWorkspaceId: string | null;
}> {
  const { response } = await jar.request('/api/auth/session');
  assert.equal(response.status, 200);
  const session = (await response.json()) as {
    activeOrganizationId?: unknown;
    activeWorkspaceId?: unknown;
  };

  return {
    activeOrganizationId:
      typeof session.activeOrganizationId === 'string' ? session.activeOrganizationId : null,
    activeWorkspaceId:
      typeof session.activeWorkspaceId === 'string' ? session.activeWorkspaceId : null,
  };
}

async function createFixtureUser(prisma: PrismaClient): Promise<string> {
  const user = await prisma.user.create({
    data: {
      identitySubject: `tenant-e2e-fixture:${randomUUID()}`,
      status: UserStatus.ACTIVE,
    },
  });
  return user.id;
}

async function createOrganization(
  prisma: PrismaClient,
  namePrefix: string,
  actorUserId: string,
  actorRole: OrganizationRole,
): Promise<string> {
  const suffix = randomUUID();
  const organization = await prisma.organization.create({
    data: {
      createdByUserId: actorUserId,
      name: `${namePrefix} ${suffix}`,
      slug: `${namePrefix.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      status: OrganizationStatus.ACTIVE,
    },
  });
  const ownerUserId =
    actorRole === OrganizationRole.OWNER ? actorUserId : await createFixtureUser(prisma);

  await prisma.organizationMembership.create({
    data: {
      activatedAt: new Date(),
      organizationId: organization.id,
      role: OrganizationRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerUserId,
    },
  });
  if (actorRole !== OrganizationRole.OWNER) {
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId: organization.id,
        role: actorRole,
        status: MembershipStatus.ACTIVE,
        userId: actorUserId,
      },
    });
  }

  return organization.id;
}

async function createWorkspace(
  prisma: PrismaClient,
  namePrefix: string,
  organizationId: string,
  actorUserId: string,
  actorRole: WorkspaceRole | null,
  status: WorkspaceStatus = WorkspaceStatus.ACTIVE,
): Promise<string> {
  const suffix = randomUUID();
  const workspace = await prisma.workspace.create({
    data: {
      archivedAt: null,
      createdByUserId: actorUserId,
      name: `${namePrefix} ${suffix}`,
      organizationId,
      slug: `${namePrefix.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
      status: WorkspaceStatus.ACTIVE,
    },
  });
  const ownerUserId =
    actorRole === WorkspaceRole.OWNER ? actorUserId : await createFixtureUser(prisma);

  if (ownerUserId !== actorUserId) {
    await prisma.organizationMembership.create({
      data: {
        activatedAt: new Date(),
        organizationId,
        role: OrganizationRole.MEMBER,
        status: MembershipStatus.ACTIVE,
        userId: ownerUserId,
      },
    });
  }
  await prisma.workspaceMembership.create({
    data: {
      activatedAt: new Date(),
      role: WorkspaceRole.OWNER,
      status: MembershipStatus.ACTIVE,
      userId: ownerUserId,
      workspaceId: workspace.id,
    },
  });
  if (actorRole && actorRole !== WorkspaceRole.OWNER) {
    await prisma.workspaceMembership.create({
      data: {
        activatedAt: new Date(),
        role: actorRole,
        status: MembershipStatus.ACTIVE,
        userId: actorUserId,
        workspaceId: workspace.id,
      },
    });
  }
  if (status === WorkspaceStatus.ARCHIVED) {
    await prisma.workspace.update({
      data: { archivedAt: new Date(), status: WorkspaceStatus.ARCHIVED },
      where: { id: workspace.id },
    });
  }

  return workspace.id;
}

async function authenticate(
  harness: TenantLifecycleE2eHarness,
  identity: TestIdentity,
): Promise<LifecycleCookieJar> {
  const jar = harness.createJar();
  const response = await harness.login(jar, identity);
  harness.assertRedirectsTo(response, '/settings');
  return jar;
}

function assertDisabledControl(html: string, label: string): void {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.match(
    html,
    new RegExp(`<button(?=[^>]*\\bdisabled(?:="")?)[^>]*>${escapedLabel}<\\/button>`, 'u'),
  );
}

export async function runTenantLifecycleE2eScenarios(
  context: TestContext,
  harness: TenantLifecycleE2eHarness,
): Promise<void> {
  const { prisma } = harness;

  await context.test('Settings requires authentication and loads for an active user', async () => {
    await harness.assertProtectedRouteDenied(harness.createJar(), '/settings');
    const identity = await harness.createIdentity('tenant-settings-access');
    const jar = await authenticate(harness, identity);
    const html = await loadSettings(jar);
    assert.match(html, /Organizations and workspaces/u);
  });

  await context.test(
    'organization owner archives and restores through the confirmed Settings action',
    async () => {
      const identity = await harness.createIdentity('tenant-organization-owner');
      const primaryOrganizationId = await createOrganization(
        prisma,
        'A Lifecycle Primary',
        identity.id,
        OrganizationRole.OWNER,
      );
      const primaryWorkspaceId = await createWorkspace(
        prisma,
        'A Primary Workspace',
        primaryOrganizationId,
        identity.id,
        WorkspaceRole.OWNER,
      );
      const fallbackOrganizationId = await createOrganization(
        prisma,
        'B Lifecycle Fallback',
        identity.id,
        OrganizationRole.OWNER,
      );
      const fallbackWorkspaceId = await createWorkspace(
        prisma,
        'B Fallback Workspace',
        fallbackOrganizationId,
        identity.id,
        WorkspaceRole.OWNER,
      );
      const membershipCount = await prisma.organizationMembership.count({
        where: { organizationId: primaryOrganizationId, userId: identity.id },
      });
      const jar = await authenticate(harness, identity);
      const initialHtml = await loadSettings(jar);

      assert.match(initialHtml, /Archive organization\?/u);
      assert.match(initialHtml, /This transition is audited/u);
      const archiveResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        initialHtml,
        'archive-organization',
        'organizationId',
        primaryOrganizationId,
      );
      harness.assertRedirectsTo(archiveResponse, '/settings');

      const archived = await prisma.organization.findUniqueOrThrow({
        where: { id: primaryOrganizationId },
      });
      assert.equal(archived.status, OrganizationStatus.ARCHIVED);
      assert.ok(archived.archivedAt);
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: fallbackOrganizationId,
        activeWorkspaceId: fallbackWorkspaceId,
      });
      assert.equal(
        await prisma.auditEvent.count({
          where: {
            action: AuditAction.ORGANIZATION_ARCHIVED,
            actorUserId: identity.id,
            targetId: primaryOrganizationId,
          },
        }),
        1,
      );

      const archivedHtml = await loadSettings(jar);
      assert.match(archivedHtml, /Archived organizations/u);
      const restoreResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        archivedHtml,
        'restore-organization',
        'organizationId',
        primaryOrganizationId,
      );
      harness.assertRedirectsTo(restoreResponse, '/settings');

      const restored = await prisma.organization.findUniqueOrThrow({
        where: { id: primaryOrganizationId },
      });
      assert.equal(restored.status, OrganizationStatus.ACTIVE);
      assert.equal(restored.archivedAt, null);
      assert.equal(
        await prisma.organizationMembership.count({
          where: { organizationId: primaryOrganizationId, userId: identity.id },
        }),
        membershipCount,
      );
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: primaryOrganizationId,
        activeWorkspaceId: primaryWorkspaceId,
      });
      assert.equal(
        await prisma.auditEvent.count({
          where: {
            action: AuditAction.ORGANIZATION_RESTORED,
            actorUserId: identity.id,
            targetId: primaryOrganizationId,
          },
        }),
        1,
      );
    },
  );

  await context.test('non-owner organization roles cannot archive through Settings', async () => {
    for (const role of [OrganizationRole.ADMIN, OrganizationRole.MEMBER, OrganizationRole.VIEWER]) {
      const identity = await harness.createIdentity(`tenant-organization-${role.toLowerCase()}`);
      const organizationId = await createOrganization(
        prisma,
        `A Unauthorized ${role}`,
        identity.id,
        role,
      );
      const jar = await authenticate(harness, identity);
      const html = await loadSettings(jar);

      assert.match(html, /Only an active organization owner can archive this organization/u);
      assertDisabledControl(html, 'Archive organization');
      const response = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        html,
        'archive-organization',
        'organizationId',
        organizationId,
      );
      assert.equal(response.status, 200, 'Denied server action must render its safe error state.');
      assert.equal(
        (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).status,
        OrganizationStatus.ACTIVE,
      );
      assert.equal(
        await prisma.auditEvent.count({
          where: { action: AuditAction.ORGANIZATION_ARCHIVED, targetId: organizationId },
        }),
        0,
      );
    }
  });

  await context.test(
    'workspace owner lifecycle rejects stale cross-organization preference fallback',
    async () => {
      const identity = await harness.createIdentity('tenant-workspace-owner');
      const organizationId = await createOrganization(
        prisma,
        'A Workspace Scope',
        identity.id,
        OrganizationRole.MEMBER,
      );
      const workspaceId = await createWorkspace(
        prisma,
        'A Selected Workspace',
        organizationId,
        identity.id,
        WorkspaceRole.OWNER,
      );
      const otherOrganizationId = await createOrganization(
        prisma,
        'B Other Tenant',
        identity.id,
        OrganizationRole.MEMBER,
      );
      await createWorkspace(
        prisma,
        'B Other Workspace',
        otherOrganizationId,
        identity.id,
        WorkspaceRole.OWNER,
      );
      const membership = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { workspaceId_userId: { userId: identity.id, workspaceId } },
      });
      const jar = await authenticate(harness, identity);
      const initialHtml = await loadSettings(jar);

      assert.match(initialHtml, /Archive workspace\?/u);
      const archiveResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        initialHtml,
        'archive-workspace',
        'workspaceId',
        workspaceId,
      );
      harness.assertRedirectsTo(archiveResponse, '/settings');
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: organizationId,
        activeWorkspaceId: null,
      });

      const archivedHtml = await loadSettings(jar);
      const restoreResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        archivedHtml,
        'restore-workspace',
        'workspaceId',
        workspaceId,
      );
      harness.assertRedirectsTo(restoreResponse, '/settings');

      const restored = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      const preservedMembership = await prisma.workspaceMembership.findUniqueOrThrow({
        where: { id: membership.id },
      });
      assert.equal(restored.organizationId, organizationId);
      assert.equal(restored.status, WorkspaceStatus.ACTIVE);
      assert.equal(preservedMembership.role, WorkspaceRole.OWNER);
      assert.equal(preservedMembership.status, MembershipStatus.ACTIVE);
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: organizationId,
        activeWorkspaceId: workspaceId,
      });
      assert.deepEqual(
        new Set(
          (
            await prisma.auditEvent.findMany({
              select: { action: true },
              where: { actorUserId: identity.id, targetId: workspaceId },
            })
          ).map(({ action }) => action),
        ),
        new Set([AuditAction.WORKSPACE_ARCHIVED, AuditAction.WORKSPACE_RESTORED]),
      );
    },
  );

  await context.test('non-owner workspace roles cannot archive through Settings', async () => {
    for (const role of [WorkspaceRole.ADMIN, WorkspaceRole.MEMBER, WorkspaceRole.VIEWER]) {
      const identity = await harness.createIdentity(`tenant-workspace-${role.toLowerCase()}`);
      const organizationId = await createOrganization(
        prisma,
        `A Workspace Unauthorized ${role}`,
        identity.id,
        OrganizationRole.MEMBER,
      );
      const workspaceId = await createWorkspace(
        prisma,
        `A Unauthorized Workspace ${role}`,
        organizationId,
        identity.id,
        role,
      );
      const jar = await authenticate(harness, identity);
      const html = await loadSettings(jar);

      assert.match(html, /Workspace archive authority is required for this action/u);
      assertDisabledControl(html, 'Archive workspace');
      const response = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        html,
        'archive-workspace',
        'workspaceId',
        workspaceId,
      );
      assert.equal(response.status, 200, 'Denied server action must render its safe error state.');
      assert.equal(
        (await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })).status,
        WorkspaceStatus.ACTIVE,
      );
      assert.equal(
        await prisma.auditEvent.count({
          where: { action: AuditAction.WORKSPACE_ARCHIVED, targetId: workspaceId },
        }),
        0,
      );
    }
  });

  await context.test(
    'organization admin manages workspace containers without receiving implicit membership',
    async () => {
      const identity = await harness.createIdentity('tenant-organization-admin-workspace');
      const organizationId = await createOrganization(
        prisma,
        'A Admin Container',
        identity.id,
        OrganizationRole.ADMIN,
      );
      const memberWorkspaceId = await createWorkspace(
        prisma,
        'A Admin Member Workspace',
        organizationId,
        identity.id,
        WorkspaceRole.ADMIN,
      );
      const directoryOnlyWorkspaceId = await createWorkspace(
        prisma,
        'B Directory Only Workspace',
        organizationId,
        identity.id,
        null,
        WorkspaceStatus.ARCHIVED,
      );
      const jar = await authenticate(harness, identity);
      const initialHtml = await loadSettings(jar);

      const archiveResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        initialHtml,
        'archive-workspace',
        'workspaceId',
        memberWorkspaceId,
      );
      harness.assertRedirectsTo(archiveResponse, '/settings');
      assert.equal((await readSession(jar)).activeWorkspaceId, null);

      const archivedHtml = await loadSettings(jar);
      const directoryRestoreResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        archivedHtml,
        'restore-workspace',
        'workspaceId',
        directoryOnlyWorkspaceId,
      );
      harness.assertRedirectsTo(directoryRestoreResponse, '/settings');
      assert.equal((await readSession(jar)).activeWorkspaceId, null);
      assert.equal(
        await prisma.workspaceMembership.count({
          where: { userId: identity.id, workspaceId: directoryOnlyWorkspaceId },
        }),
        0,
      );

      const managedRestoreHtml = await loadSettings(jar);
      const managedRestoreResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        managedRestoreHtml,
        'restore-workspace',
        'workspaceId',
        memberWorkspaceId,
      );
      harness.assertRedirectsTo(managedRestoreResponse, '/settings');
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: organizationId,
        activeWorkspaceId: memberWorkspaceId,
      });
      const membership = await prisma.workspaceMembership.findUniqueOrThrow({
        where: {
          workspaceId_userId: { userId: identity.id, workspaceId: memberWorkspaceId },
        },
      });
      assert.equal(membership.role, WorkspaceRole.ADMIN);
    },
  );

  await context.test(
    'cross-tenant lifecycle form tampering is denied without mutation',
    async () => {
      const identity = await harness.createIdentity('tenant-cross-scope');
      const ownOrganizationId = await createOrganization(
        prisma,
        'A Own Tenant',
        identity.id,
        OrganizationRole.OWNER,
      );
      const ownWorkspaceId = await createWorkspace(
        prisma,
        'A Own Workspace',
        ownOrganizationId,
        identity.id,
        WorkspaceRole.OWNER,
      );
      const foreignOwnerId = await createFixtureUser(prisma);
      const foreignOrganizationId = await createOrganization(
        prisma,
        'Z Foreign Tenant',
        foreignOwnerId,
        OrganizationRole.OWNER,
      );
      const foreignWorkspaceId = await createWorkspace(
        prisma,
        'Z Foreign Workspace',
        foreignOrganizationId,
        foreignOwnerId,
        WorkspaceRole.OWNER,
      );
      const jar = await authenticate(harness, identity);
      const html = await loadSettings(jar);

      const organizationResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        html,
        'archive-organization',
        'organizationId',
        ownOrganizationId,
        foreignOrganizationId,
      );
      assert.equal(organizationResponse.status, 200);
      const workspaceResponse = await submitLifecycleForm(
        jar,
        harness.baseUrl,
        html,
        'archive-workspace',
        'workspaceId',
        ownWorkspaceId,
        foreignWorkspaceId,
      );
      assert.equal(workspaceResponse.status, 200);

      assert.equal(
        (await prisma.organization.findUniqueOrThrow({ where: { id: foreignOrganizationId } }))
          .status,
        OrganizationStatus.ACTIVE,
      );
      assert.equal(
        (await prisma.workspace.findUniqueOrThrow({ where: { id: foreignWorkspaceId } })).status,
        WorkspaceStatus.ACTIVE,
      );
      assert.equal(
        await prisma.auditEvent.count({
          where: { targetId: { in: [foreignOrganizationId, foreignWorkspaceId] } },
        }),
        0,
      );
      assert.deepEqual(await readSession(jar), {
        activeOrganizationId: ownOrganizationId,
        activeWorkspaceId: ownWorkspaceId,
      });
    },
  );
}
