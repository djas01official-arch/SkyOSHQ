import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';

const EXPECTED_DATABASE = 'skyos';
const EXPECTED_MIGRATOR = 'skyos_migrator';
const EXPECTED_ROLE_NAMES = ['skyos_application_role', 'skyos_reconciliation_role'] as const;

type CurrentIdentityRow = {
  currentUser: string;
  currentDatabase: string;
};

type RoleSafetyRow = {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
};

function requireMigrationDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error('Production database role bootstrap configuration is invalid.');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(databaseUrl);
  } catch {
    throw new Error('Production database role bootstrap configuration is invalid.');
  }

  if (parsedUrl.pathname !== `/${EXPECTED_DATABASE}`) {
    throw new Error('Production database role bootstrap configuration is invalid.');
  }

  return databaseUrl;
}

function assertExpectedIdentity(rows: readonly CurrentIdentityRow[]): void {
  const currentIdentity = rows[0];

  if (
    rows.length !== 1 ||
    currentIdentity?.currentUser !== EXPECTED_MIGRATOR ||
    currentIdentity.currentDatabase !== EXPECTED_DATABASE
  ) {
    throw new Error('Production database role bootstrap target is invalid.');
  }
}

function isSafeBootstrapRole(role: RoleSafetyRow): boolean {
  return (
    !role.rolcanlogin &&
    !role.rolsuper &&
    !role.rolcreatedb &&
    !role.rolcreaterole &&
    !role.rolreplication
  );
}

function assertBootstrapRoles(rows: readonly RoleSafetyRow[]): void {
  const rolesByName = new Map(rows.map((role) => [role.rolname, role]));

  if (
    rows.length !== EXPECTED_ROLE_NAMES.length ||
    !EXPECTED_ROLE_NAMES.every((roleName) => {
      const role = rolesByName.get(roleName);
      return role !== undefined && isSafeBootstrapRole(role);
    })
  ) {
    throw new Error('Production database role bootstrap verification failed.');
  }
}

async function readBootstrapSql(): Promise<string> {
  const bootstrapSqlPath = resolve(
    process.cwd(),
    'database',
    'production',
    'bootstrap-database-roles.sql',
  );
  const bootstrapSql = await readFile(bootstrapSqlPath, 'utf8');

  if (!bootstrapSql.trim()) {
    throw new Error('Production database role bootstrap artifact is invalid.');
  }

  return bootstrapSql;
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: requireMigrationDatabaseUrl() });
  let transactionOpen = false;

  try {
    await client.connect();

    const identityResult = await client.query<CurrentIdentityRow>(
      'SELECT current_user AS "currentUser", current_database() AS "currentDatabase";',
    );
    assertExpectedIdentity(identityResult.rows);

    const bootstrapSql = await readBootstrapSql();

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(bootstrapSql);

    const roleResult = await client.query<RoleSafetyRow>(
      `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_catalog.pg_roles
       WHERE rolname = ANY($1::text[])`,
      [EXPECTED_ROLE_NAMES],
    );
    assertBootstrapRoles(roleResult.rows);

    await client.query('COMMIT');
    transactionOpen = false;
  } catch {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The caller receives the same generic failure without provider details.
      }
    }

    throw new Error('Production database role bootstrap failed.');
  } finally {
    await client.end();
  }
}

void main()
  .then(() => {
    console.log('Production database role bootstrap: PASS');
  })
  .catch(() => {
    console.error('Production database role bootstrap: FAIL');
    process.exitCode = 1;
  });
