import { GoogleLoginForm } from '@/components/auth/google-login-form';
import { LoginForm } from '@/components/auth/login-form';
import { LoginPageContent } from '@/components/auth/login-page-content';
import { isDevelopmentCredentialsEnabled } from '@/lib/auth/development-credentials';
import { getGoogleOidcConfiguration, isGoogleOidcProviderEnabled } from '@/lib/auth/google-oidc';
import { getSafeSignInRedirect } from '@/lib/auth/security';

export const metadata = {
  title: 'Sign in',
};

type LoginPageProps = {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const callbackUrl = (await searchParams).callbackUrl;
  const redirectTo = getSafeSignInRedirect(
    Array.isArray(callbackUrl) ? callbackUrl[0] : callbackUrl,
  );
  const credentialsEnabled = isDevelopmentCredentialsEnabled();
  const googleEnabled = isGoogleOidcProviderEnabled(
    process.env.NODE_ENV,
    getGoogleOidcConfiguration(),
  );

  return (
    <LoginPageContent
      credentialsEnabled={credentialsEnabled}
      credentialsForm={credentialsEnabled ? <LoginForm redirectTo={redirectTo} /> : null}
      googleEnabled={googleEnabled}
      googleSignInForm={googleEnabled ? <GoogleLoginForm redirectTo={redirectTo} /> : null}
    />
  );
}
