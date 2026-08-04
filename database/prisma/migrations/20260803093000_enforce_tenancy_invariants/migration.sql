-- A workspace's owning organization is part of its immutable tenancy boundary.
CREATE FUNCTION "prevent_workspace_organization_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."organizationId" <> OLD."organizationId" THEN
        RAISE EXCEPTION 'Workspace organizationId cannot be reassigned';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspaces_organization_identity_immutable"
BEFORE UPDATE OF "organizationId" ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "prevent_workspace_organization_reassignment"();

-- Active scopes must always retain an active owner. Constraint triggers defer the
-- check to transaction commit, allowing ownership to be transferred atomically.
CREATE FUNCTION "ensure_active_organization_has_owner"()
RETURNS TRIGGER AS $$
DECLARE
    scoped_organization_id UUID;
BEGIN
    scoped_organization_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."organizationId"
        ELSE NEW."organizationId"
    END;

    IF EXISTS (
        SELECT 1
        FROM "organizations"
        WHERE "id" = scoped_organization_id
          AND "status" = 'ACTIVE'
          AND "deletedAt" IS NULL
    ) AND NOT EXISTS (
        SELECT 1
        FROM "organization_memberships"
        WHERE "organizationId" = scoped_organization_id
          AND "role" = 'OWNER'
          AND "status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'An active organization must retain an active owner';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "organizations_require_active_owner"
AFTER INSERT OR UPDATE OR DELETE ON "organization_memberships"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ensure_active_organization_has_owner"();

CREATE FUNCTION "ensure_active_workspace_has_owner"()
RETURNS TRIGGER AS $$
DECLARE
    scoped_workspace_id UUID;
BEGIN
    scoped_workspace_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."workspaceId"
        ELSE NEW."workspaceId"
    END;

    IF EXISTS (
        SELECT 1
        FROM "workspaces"
        WHERE "id" = scoped_workspace_id
          AND "status" = 'ACTIVE'
          AND "deletedAt" IS NULL
    ) AND NOT EXISTS (
        SELECT 1
        FROM "workspace_memberships"
        WHERE "workspaceId" = scoped_workspace_id
          AND "role" = 'OWNER'
          AND "status" = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'An active workspace must retain an active owner';
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "workspaces_require_active_owner"
AFTER INSERT OR UPDATE OR DELETE ON "workspace_memberships"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "ensure_active_workspace_has_owner"();

-- While archived, only restoration is permitted on the scope record itself.
CREATE FUNCTION "reject_normal_archived_organization_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."status" = 'ARCHIVED' AND (
        NEW."status" <> 'ACTIVE'
        OR NEW."archivedAt" IS NOT NULL
        OR NEW."name" IS DISTINCT FROM OLD."name"
        OR NEW."slug" IS DISTINCT FROM OLD."slug"
        OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
        OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    ) THEN
        RAISE EXCEPTION 'An archived organization only permits restoration';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organizations_reject_normal_archived_mutations"
BEFORE UPDATE ON "organizations"
FOR EACH ROW EXECUTE FUNCTION "reject_normal_archived_organization_mutation"();

CREATE FUNCTION "reject_normal_archived_workspace_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD."status" = 'ARCHIVED' AND (
        NEW."status" <> 'ACTIVE'
        OR NEW."archivedAt" IS NOT NULL
        OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
        OR NEW."name" IS DISTINCT FROM OLD."name"
        OR NEW."slug" IS DISTINCT FROM OLD."slug"
        OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
        OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    ) THEN
        RAISE EXCEPTION 'An archived workspace only permits restoration';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspaces_reject_normal_archived_mutations"
BEFORE UPDATE ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "reject_normal_archived_workspace_mutation"();

-- Membership and workspace changes are normal mutations and cannot occur while
-- their organization or workspace is archived.
CREATE FUNCTION "reject_archived_organization_membership_mutation"()
RETURNS TRIGGER AS $$
DECLARE
    scoped_organization_id UUID;
BEGIN
    scoped_organization_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."organizationId"
        ELSE NEW."organizationId"
    END;

    IF EXISTS (
        SELECT 1
        FROM "organizations"
        WHERE "id" = scoped_organization_id
          AND "status" = 'ARCHIVED'
    ) THEN
        RAISE EXCEPTION 'Archived organizations reject membership mutations';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organization_memberships_reject_archived_organization_mutations"
BEFORE INSERT OR UPDATE OR DELETE ON "organization_memberships"
FOR EACH ROW EXECUTE FUNCTION "reject_archived_organization_membership_mutation"();

CREATE FUNCTION "reject_archived_workspace_or_organization_mutation"()
RETURNS TRIGGER AS $$
DECLARE
    scoped_workspace_id UUID;
BEGIN
    scoped_workspace_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."workspaceId"
        ELSE NEW."workspaceId"
    END;

    IF EXISTS (
        SELECT 1
        FROM "workspaces"
        INNER JOIN "organizations" ON "organizations"."id" = "workspaces"."organizationId"
        WHERE "workspaces"."id" = scoped_workspace_id
          AND ("workspaces"."status" = 'ARCHIVED' OR "organizations"."status" = 'ARCHIVED')
    ) THEN
        RAISE EXCEPTION 'Archived workspaces and organizations reject membership mutations';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspace_memberships_reject_archived_scope_mutations"
BEFORE INSERT OR UPDATE OR DELETE ON "workspace_memberships"
FOR EACH ROW EXECUTE FUNCTION "reject_archived_workspace_or_organization_mutation"();

CREATE FUNCTION "reject_workspace_mutation_for_archived_organization"()
RETURNS TRIGGER AS $$
DECLARE
    scoped_organization_id UUID;
BEGIN
    scoped_organization_id := CASE
        WHEN TG_OP = 'DELETE' THEN OLD."organizationId"
        ELSE NEW."organizationId"
    END;

    IF EXISTS (
        SELECT 1
        FROM "organizations"
        WHERE "id" = scoped_organization_id
          AND "status" = 'ARCHIVED'
    ) THEN
        RAISE EXCEPTION 'Archived organizations reject workspace mutations';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "workspaces_reject_archived_organization_mutations"
BEFORE INSERT OR UPDATE OR DELETE ON "workspaces"
FOR EACH ROW EXECUTE FUNCTION "reject_workspace_mutation_for_archived_organization"();

-- This read-only predicate centralizes the relationship status required for
-- effective workspace membership. Permission-grant evaluation remains in the
-- future authorization layer.
CREATE FUNCTION "has_effective_workspace_membership"(target_workspace_id UUID, target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM "workspace_memberships"
        INNER JOIN "workspaces" ON "workspaces"."id" = "workspace_memberships"."workspaceId"
        INNER JOIN "organizations" ON "organizations"."id" = "workspaces"."organizationId"
        INNER JOIN "organization_memberships"
            ON "organization_memberships"."organizationId" = "organizations"."id"
            AND "organization_memberships"."userId" = "workspace_memberships"."userId"
        INNER JOIN "users" ON "users"."id" = "workspace_memberships"."userId"
        WHERE "workspace_memberships"."workspaceId" = target_workspace_id
          AND "workspace_memberships"."userId" = target_user_id
          AND "workspace_memberships"."status" = 'ACTIVE'
          AND "organization_memberships"."status" = 'ACTIVE'
          AND "workspaces"."status" = 'ACTIVE'
          AND "workspaces"."deletedAt" IS NULL
          AND "organizations"."status" = 'ACTIVE'
          AND "organizations"."deletedAt" IS NULL
          AND "users"."status" = 'ACTIVE'
          AND "users"."deletedAt" IS NULL
    );
$$;
