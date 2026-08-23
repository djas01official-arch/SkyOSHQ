-- Bootstraps only NOLOGIN custom roles. Run as the privileged migration bootstrap
-- identity before Cloud SQL application or reconciliation users are created. Object
-- privileges are intentionally applied later after reviewed Prisma migrations; this
-- script does not run Prisma migrations.

DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'skyos_application_role'
  ) THEN
    CREATE ROLE skyos_application_role
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$role$;

ALTER ROLE skyos_application_role
  NOLOGIN
  NOCREATEDB
  NOCREATEROLE;
DO $role$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'skyos_reconciliation_role'
  ) THEN
    CREATE ROLE skyos_reconciliation_role
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION;
  END IF;
END
$role$;

ALTER ROLE skyos_reconciliation_role
  NOLOGIN
  NOCREATEDB
  NOCREATEROLE;