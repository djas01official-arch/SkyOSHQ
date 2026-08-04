-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "identitySubject" TEXT,
    "displayName" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organizations_archive_state_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "organization_memberships_revoked_at_check" CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspaces_archive_state_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "workspace_memberships" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "activatedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workspace_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_memberships_revoked_at_check" CHECK ("status" <> 'REVOKED' OR "revokedAt" IS NOT NULL)
);

-- CreateIndex
CREATE UNIQUE INDEX "users_identitySubject_key" ON "users"("identitySubject");
CREATE INDEX "users_status_idx" ON "users"("status");
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");
CREATE INDEX "organizations_status_idx" ON "organizations"("status");
CREATE INDEX "organizations_deletedAt_idx" ON "organizations"("deletedAt");
CREATE UNIQUE INDEX "organizations_active_slug_key" ON "organizations"("slug") WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;
CREATE INDEX "organization_memberships_organizationId_status_role_idx" ON "organization_memberships"("organizationId", "status", "role");
CREATE INDEX "organization_memberships_userId_status_idx" ON "organization_memberships"("userId", "status");
CREATE UNIQUE INDEX "organization_memberships_organizationId_userId_key" ON "organization_memberships"("organizationId", "userId");
CREATE INDEX "workspaces_organizationId_status_idx" ON "workspaces"("organizationId", "status");
CREATE INDEX "workspaces_deletedAt_idx" ON "workspaces"("deletedAt");
CREATE UNIQUE INDEX "workspaces_active_organization_slug_key" ON "workspaces"("organizationId", "slug") WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;
CREATE INDEX "workspace_memberships_workspaceId_status_role_idx" ON "workspace_memberships"("workspaceId", "status", "role");
CREATE INDEX "workspace_memberships_userId_status_idx" ON "workspace_memberships"("userId", "status");
CREATE UNIQUE INDEX "workspace_memberships_workspaceId_userId_key" ON "workspace_memberships"("workspaceId", "userId");

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Membership identity fields are immutable after creation.
CREATE FUNCTION "prevent_organization_membership_identity_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."organizationId" <> OLD."organizationId" OR NEW."userId" <> OLD."userId" THEN
        RAISE EXCEPTION 'Organization membership organizationId and userId cannot be reassigned';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organization_memberships_identity_immutable"
BEFORE UPDATE OF "organizationId", "userId" ON "organization_memberships"
FOR EACH ROW EXECUTE FUNCTION "prevent_organization_membership_identity_reassignment"();

CREATE FUNCTION "prevent_workspace_membership_identity_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."workspaceId" <> OLD."workspaceId" OR NEW."userId" <> OLD."userId" THEN
        RAISE EXCEPTION 'Workspace membership workspaceId and userId cannot be reassigned';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspace_memberships_identity_immutable"
BEFORE UPDATE OF "workspaceId", "userId" ON "workspace_memberships"
FOR EACH ROW EXECUTE FUNCTION "prevent_workspace_membership_identity_reassignment"();

-- An active workspace membership requires an active parent-organization membership.
-- Suspending or revoking the parent membership later leaves this row intact but
-- makes access ineffective in the authorization layer, as defined by the domain model.
CREATE FUNCTION "enforce_active_parent_organization_membership"()
RETURNS TRIGGER AS $$
DECLARE
    workspace_organization_id UUID;
BEGIN
    IF NEW."status" <> 'ACTIVE' THEN
        RETURN NEW;
    END IF;

    SELECT "organizationId"
    INTO workspace_organization_id
    FROM "workspaces"
    WHERE "id" = NEW."workspaceId";

    IF workspace_organization_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM "organization_memberships"
        WHERE "organizationId" = workspace_organization_id
          AND "userId" = NEW."userId"
          AND "status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'An active workspace membership requires an active organization membership';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspace_memberships_require_active_organization_membership"
BEFORE INSERT OR UPDATE OF "workspaceId", "userId", "status" ON "workspace_memberships"
FOR EACH ROW EXECUTE FUNCTION "enforce_active_parent_organization_membership"();
