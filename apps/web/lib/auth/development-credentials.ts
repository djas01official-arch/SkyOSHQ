/**
 * Credentials authentication exists only to support local development and
 * isolated test coverage until SkyOS selects a production identity provider.
 * Unknown runtimes deliberately fail closed.
 */
export function isDevelopmentCredentialsEnabled(runtime: unknown = process.env.NODE_ENV): boolean {
  return runtime === 'development' || runtime === 'test';
}
