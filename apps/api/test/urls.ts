/** Admin connection to any database on the test server. Defaults to the Compose Postgres. */
export const serverAdminUrl = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres';

export const testDbName = 'fndn_test';

function withDatabase(base: string, database: string, credentials?: { user: string; password: string }): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (credentials) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

export const adminDbUrl = withDatabase(serverAdminUrl, testDbName);
/** The tests use the same least-privilege role as production, so grants are exercised too. */
export const appDbUrl = withDatabase(serverAdminUrl, testDbName, { user: 'fndn_api_test', password: 'test-only' });
