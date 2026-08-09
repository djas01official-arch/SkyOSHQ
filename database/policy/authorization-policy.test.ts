import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrganizationRole, WorkspaceRole } from '../generated/client/client';
import {
  organizationRoleGrantsPermission,
  workspaceRoleGrantsPermission,
} from './authorization-policy';

test('Prisma organization roles map to the application-owned policy catalog', () => {
  assert.equal(
    organizationRoleGrantsPermission(OrganizationRole.OWNER, 'organization.archive'),
    true,
  );
  assert.equal(
    organizationRoleGrantsPermission(OrganizationRole.ADMIN, 'organization.members.manage'),
    true,
  );
  assert.equal(
    organizationRoleGrantsPermission(OrganizationRole.MEMBER, 'organization.workspaces.read'),
    false,
  );
  assert.equal(
    organizationRoleGrantsPermission(OrganizationRole.VIEWER, 'organization.read'),
    true,
  );
});

test('Prisma workspace roles map to the application-owned policy catalog', () => {
  assert.equal(workspaceRoleGrantsPermission(WorkspaceRole.OWNER, 'workspace.archive'), true);
  assert.equal(workspaceRoleGrantsPermission(WorkspaceRole.ADMIN, 'workspace.archive'), false);
  assert.equal(workspaceRoleGrantsPermission(WorkspaceRole.MEMBER, 'knowledge.write'), true);
  assert.equal(workspaceRoleGrantsPermission(WorkspaceRole.VIEWER, 'knowledge.write'), false);
  assert.equal(workspaceRoleGrantsPermission(WorkspaceRole.VIEWER, 'knowledge.read'), true);
});
