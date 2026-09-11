import type { AccessTokenProvider } from '@anthropic-ai/sdk/lib/credentials';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_AUDIENCE = 'https://api.anthropic.com';
const GOOGLE_METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';
const ID_PATTERN = /^[A-Za-z0-9_-]+$/u;
const ORGANIZATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const METADATA_TIMEOUT_MS = 5_000;

export type AnthropicGoogleCloudWorkloadIdentityOptions = Readonly<{
  federationRuleId: string;
  identityTokenFetch?: typeof globalThis.fetch;
  identityTokenProvider?: () => string | Promise<string>;
  organizationId: string;
  serviceAccountId: string;
  tokenExchangeFetch?: typeof globalThis.fetch;
  workspaceId?: string;
}>;

function validTaggedId(value: string, prefix: string): boolean {
  return value.length > prefix.length && value.startsWith(prefix) && ID_PATTERN.test(value);
}

export function isValidAnthropicGoogleCloudWorkloadIdentityConfiguration(
  options: AnthropicGoogleCloudWorkloadIdentityOptions,
): boolean {
  return (
    validTaggedId(options.federationRuleId, 'fdrl_') &&
    ORGANIZATION_ID_PATTERN.test(options.organizationId) &&
    validTaggedId(options.serviceAccountId, 'svac_') &&
    (options.workspaceId === undefined ||
      options.workspaceId === 'default' ||
      validTaggedId(options.workspaceId, 'wrkspc_'))
  );
}

export async function fetchGoogleCloudAnthropicIdentityToken(
  transport: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const url = new URL(GOOGLE_METADATA_IDENTITY_URL);
  url.searchParams.set('audience', ANTHROPIC_AUDIENCE);
  url.searchParams.set('format', 'full');
  const response = await transport(url, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error('Google Cloud workload identity token acquisition failed.');
  }
  const token = (await response.text()).trim();
  if (!JWT_PATTERN.test(token) || token.length > 16 * 1024) {
    throw new Error('Google Cloud workload identity token is invalid.');
  }
  return token;
}

export function createAnthropicGoogleCloudWorkloadIdentityCredentials(
  options: AnthropicGoogleCloudWorkloadIdentityOptions,
): AccessTokenProvider {
  if (!isValidAnthropicGoogleCloudWorkloadIdentityConfiguration(options)) {
    throw new Error('Anthropic Google Cloud workload identity configuration is invalid.');
  }
  const identityTokenProvider =
    options.identityTokenProvider ??
    (() => fetchGoogleCloudAnthropicIdentityToken(options.identityTokenFetch));
  return oidcFederationProvider({
    baseURL: ANTHROPIC_BASE_URL,
    federationRuleId: options.federationRuleId,
    fetch: options.tokenExchangeFetch ?? globalThis.fetch,
    identityTokenProvider,
    organizationId: options.organizationId,
    serviceAccountId: options.serviceAccountId,
    workspaceId: options.workspaceId,
  });
}
