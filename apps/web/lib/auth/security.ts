const AUTH_SECRET_MINIMUM_LENGTH = 32;
const AUTH_SECRET_PLACEHOLDER_PATTERN = /(change[-_ ]?me|example|replace[-_ ]?with)/i;
const ENCODED_UNSAFE_CHARACTER_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i;

export const AUTH_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
export const DEFAULT_SIGN_IN_REDIRECT = '/dashboard';

type SessionLike = {
  user?: {
    id?: unknown;
  } | null;
} | null;

export function hasAuthenticatedUser(session: SessionLike | undefined): boolean {
  return typeof session?.user?.id === 'string' && session.user.id.length > 0;
}

export function requireAuthSecret(value: string | undefined): string {
  if (
    !value ||
    value.length < AUTH_SECRET_MINIMUM_LENGTH ||
    AUTH_SECRET_PLACEHOLDER_PATTERN.test(value)
  ) {
    throw new Error(
      'AUTH_SECRET must be a non-placeholder value containing at least 32 characters.',
    );
  }

  return value;
}

export function getSessionCookie(useSecureCookies: boolean) {
  return {
    name: `${useSecureCookies ? '__Secure-' : ''}authjs.session-token`,
    options: {
      httpOnly: true,
      path: '/',
      sameSite: 'lax' as const,
      secure: useSecureCookies,
    },
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }

  return false;
}

/** Returns a same-origin application path or the dashboard fallback. */
export function getSafeSignInRedirect(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    hasControlCharacter(value) ||
    ENCODED_UNSAFE_CHARACTER_PATTERN.test(value)
  ) {
    return DEFAULT_SIGN_IN_REDIRECT;
  }

  try {
    const baseUrl = new URL('https://skyos.invalid');
    const redirectUrl = new URL(value, baseUrl);

    if (
      redirectUrl.origin !== baseUrl.origin ||
      redirectUrl.pathname === '/login' ||
      redirectUrl.pathname.startsWith('/login/')
    ) {
      return DEFAULT_SIGN_IN_REDIRECT;
    }

    return `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
  } catch {
    return DEFAULT_SIGN_IN_REDIRECT;
  }
}
