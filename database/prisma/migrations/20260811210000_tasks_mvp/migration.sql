CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

CREATE TABLE "tasks" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "assigneeUserId" UUID,
    "dueAt" DATE,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tasks_title_length_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
    CONSTRAINT "tasks_description_length_check" CHECK ("description" IS NULL OR char_length("description") <= 10000)
);

CREATE INDEX "tasks_active_workspace_list_idx"
ON "tasks"("workspaceId", "status", "dueAt", "updatedAt" DESC, "id")
WHERE "archivedAt" IS NULL;

CREATE INDEX "tasks_workspaceId_idx"
ON "tasks"("workspaceId");

CREATE INDEX "tasks_createdByUserId_createdAt_idx"
ON "tasks"("createdByUserId", "createdAt");

CREATE INDEX "tasks_assigneeUserId_updatedAt_idx"
ON "tasks"("assigneeUserId", "updatedAt");

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "tasks"
ADD CONSTRAINT "tasks_assigneeUserId_fkey"
FOREIGN KEY ("assigneeUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "prevent_task_identity_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
       OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
        RAISE EXCEPTION 'Task identity, workspaceId, and createdByUserId cannot be reassigned';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tasks_identity_immutable"
BEFORE UPDATE ON "tasks"
FOR EACH ROW EXECUTE FUNCTION "prevent_task_identity_reassignment"();
