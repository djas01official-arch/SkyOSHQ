export const GOOGLE_PROVIDER_ID = 'google';
export const GOOGLE_ACCOUNT_TYPE = 'oidc';

const MAX_GOOGLE_CLIENT_CONFIGURATION_LENGTH = 4_096;
const MAX_GOOGLE_SUBJECT_LENGTH = 512;
const MAX_GOOGLE_EMAIL_LENGTH = 320;

export type GoogleOidcConfiguration = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type GoogleOidcIdentity = Readonly<{
  email: string;
  subject: string;
}>;

type GoogleOidcAccount = Readonly<{
  provider?: unknown;
  providerAccountId?: unknown;
  type?: unknown;
}>;

type GoogleOidcProfile = Readonly<{
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
}>;

function getBoundedNonBlankString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;

  return value.trim().length > 0 && value.length <= maximumLength ? value : null;
}

/** Reads explicit server-only Google OIDC configuration without ambient provider registration. */
export function getGoogleOidcConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): GoogleOidcConfiguration | null {
  const clientId = getBoundedNonBlankString(
    environment.AUTH_GOOGLE_ID,
    MAX_GOOGLE_CLIENT_CONFIGURATION_LENGTH,
  );
  const clientSecret = getBoundedNonBlankString(
    environment.AUTH_GOOGLE_SECRET,
    MAX_GOOGLE_CLIENT_CONFIGURATION_LENGTH,
  );

  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/**
 * Checks the provider data passed by Auth.js before any OAuth persistence path
 * can create or link an account. Google `sub` is kept byte-for-byte as the
 * provider identity; email is only verified profile metadata.
 */
export function getValidatedGoogleOidcIdentity(
  account: GoogleOidcAccount | null | undefined,
  profile: GoogleOidcProfile | null | undefined,
): GoogleOidcIdentity | null {
  const subject = getBoundedNonBlankString(profile?.sub, MAX_GOOGLE_SUBJECT_LENGTH);
  const email = getBoundedNonBlankString(profile?.email, MAX_GOOGLE_EMAIL_LENGTH);

  if (
    !subject ||
    !email ||
    profile?.email_verified !== true ||
    account?.provider !== GOOGLE_PROVIDER_ID ||
    account.type !== GOOGLE_ACCOUNT_TYPE ||
    account.providerAccountId !== subject
  ) {
    return null;
  }

  return { email, subject };
}

export function isGoogleOidcConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return getGoogleOidcConfiguration(environment) !== null;
}

/** Google is deliberately unavailable in unknown runtimes even if values exist. */
export function isGoogleOidcProviderEnabled(
  runtime: unknown = process.env.NODE_ENV,
  configuration: GoogleOidcConfiguration | null = getGoogleOidcConfiguration(),
): boolean {
  return (
    configuration !== null &&
    (runtime === 'development' || runtime === 'test' || runtime === 'production')
  );
}
