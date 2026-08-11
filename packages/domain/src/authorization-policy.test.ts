import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORGANIZATION_PERMISSION_KEYS,
  WORKSPACE_PERMISSION_KEYS,
  hasOrganizationPermission,
  hasWorkspacePermission,
  organizationPermissions,
  organizationRoles,
  roleGrantsPermission,
  workspacePermissions,
  workspaceRoles,
} from './authorization-policy.js';

test('the policy catalog contains only the approved permission definitions', () => {
  assert.deepEqual(Object.keys(organizationPermissions), [...ORGANIZATION_PERMISSION_KEYS]);
  assert.deepEqual(Object.keys(workspacePermissions), [...WORKSPACE_PERMISSION_KEYS]);
  assert.deepEqual(Object.keys(organizationRoles), ['owner', 'admin', 'member', 'viewer']);
  assert.deepEqual(Object.keys(workspaceRoles), ['owner', 'admin', 'member', 'viewer']);
});

test('organization roles grant the approved organization permissions', () => {
  assert.equal(hasOrganizationPermission('owner', 'organization.archive'), true);
  assert.equal(hasOrganizationPermission('admin', 'organization.workspaces.manage'), true);
  assert.equal(hasOrganizationPermission('admin', 'organization.archive'), false);
  assert.equal(hasOrganizationPermission('admin', 'organization.transfer_ownership'), false);
  assert.equal(hasOrganizationPermission('member', 'organization.read'), true);
  assert.equal(hasOrganizationPermission('viewer', 'organization.update'), false);
});

test('workspace roles grant the approved workspace permissions', () => {
  assert.equal(hasWorkspacePermission('owner', 'workspace.archive'), true);
  assert.equal(hasWorkspacePermission('admin', 'workspace.archive'), false);
  assert.equal(hasWorkspacePermission('admin', 'workspace.members.manage'), true);
  assert.equal(hasWorkspacePermission('member', 'knowledge.write'), true);
  assert.equal(hasWorkspacePermission('member', 'tasks.write'), true);
  assert.equal(hasWorkspacePermission('viewer', 'knowledge.read'), true);
  assert.equal(hasWorkspacePermission('viewer', 'knowledge.write'), false);
  assert.equal(hasWorkspacePermission('viewer', 'tasks.read'), true);
  assert.equal(hasWorkspacePermission('viewer', 'tasks.write'), false);
  assert.equal(hasWorkspacePermission('viewer', 'ai.use'), false);
});

test('organization roles never grant workspace permissions implicitly', () => {
  assert.equal(
    roleGrantsPermission(
      { key: 'owner', scope: 'organization' },
      { key: 'knowledge.read', scope: 'workspace' },
    ),
    false,
  );
  assert.equal(
    roleGrantsPermission(
      { key: 'admin', scope: 'workspace' },
      { key: 'organization.workspaces.manage', scope: 'organization' },
    ),
    false,
  );
});

test('policy definitions are immutable at runtime', () => {
  assert.equal(Object.isFrozen(ORGANIZATION_PERMISSION_KEYS), true);
  assert.equal(Object.isFrozen(WORKSPACE_PERMISSION_KEYS), true);
  assert.equal(Object.isFrozen(organizationPermissions), true);
  assert.equal(Object.isFrozen(workspacePermissions), true);
  assert.equal(Object.isFrozen(organizationRoles.owner), true);
  assert.equal(Object.isFrozen(organizationRoles.owner.permissions), true);
  assert.equal(Object.isFrozen(workspaceRoles.viewer), true);
  assert.equal(Object.isFrozen(workspaceRoles.viewer.permissions), true);
});
