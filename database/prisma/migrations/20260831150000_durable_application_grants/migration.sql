-- Keep application privileges durable across future Prisma migrations.
-- This migration runs as skyos_migrator.

GRANT USAGE ON SCHEMA public TO skyos_application_role;

GRANT SELECT, INSERT, UPDATE, DELETE
ON ALL TABLES IN SCHEMA public
TO skyos_application_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLES
TO skyos_application_role;

-- Migration bookkeeping must never be available to the application role.
REVOKE ALL
ON TABLE public._prisma_migrations
FROM skyos_application_role;

-- Audit records are append-only for the application.
REVOKE UPDATE, DELETE
ON TABLE public.audit_events
FROM skyos_application_role;

REVOKE UPDATE, DELETE
ON TABLE public.identity_audit_events
FROM skyos_application_role;
