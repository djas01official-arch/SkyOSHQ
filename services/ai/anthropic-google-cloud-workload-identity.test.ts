import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createAnthropicGoogleCloudWorkloadIdentityCredentials,
  fetchGoogleCloudAnthropicIdentityToken,
  isValidAnthropicGoogleCloudWorkloadIdentityConfiguration,
} from './anthropic-google-cloud-workload-identity';

const configuration = {
  federationRuleId: 'fdrl_test-rule',
  organizationId: '123e4567-e89b-42d3-a456-426614174000',
  serviceAccountId: 'svac_test-service-account',
  workspaceId: 'wrkspc_test-workspace',
} as const;

function fakeFetch(handler: (request: Request) => Promise<Response> | Response): {
  calls: Request[];
  fetch: typeof globalThis.fetch;
} {
  const calls: Request[] = [];
  return {
    calls,
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      calls.push(request.clone());
      return handler(request);
    }) as typeof globalThis.fetch,
  };
}

test('fetches a full Google identity token for the exact Anthropic audience', async () => {
  const transport = fakeFetch(() => new Response('header.payload.signature'));
  const token = await fetchGoogleCloudAnthropicIdentityToken(transport.fetch);

  assert.equal(token, 'header.payload.signature');
  assert.equal(transport.calls.length, 1);
  const request = transport.calls[0]!;
  const url = new URL(request.url);
  assert.equal(url.hostname, 'metadata.google.internal');
  assert.equal(url.searchParams.get('audience'), 'https://api.anthropic.com');
  assert.equal(url.searchParams.get('format'), 'full');
  assert.equal(request.headers.get('metadata-flavor'), 'Google');
});

test('rejects failed metadata responses and malformed identity tokens', async () => {
  await assert.rejects(
    fetchGoogleCloudAnthropicIdentityToken(
      fakeFetch(() => new Response('unavailable', { status: 503 })).fetch,
    ),
    /token acquisition failed/u,
  );
  await assert.rejects(
    fetchGoogleCloudAnthropicIdentityToken(fakeFetch(() => new Response('not-a-jwt')).fetch),
    /token is invalid/u,
  );
});

test('exchanges the Google assertion without exposing a static API key', async () => {
  const exchange = fakeFetch(async (request) => {
    const body = JSON.parse(await request.text()) as Record<string, string>;
    assert.equal(new URL(request.url).pathname, '/v1/oauth/token');
    assert.equal(body.assertion, 'header.payload.signature');
    assert.equal(body.federation_rule_id, configuration.federationRuleId);
    assert.equal(body.organization_id, configuration.organizationId);
    assert.equal(body.service_account_id, configuration.serviceAccountId);
    assert.equal(body.workspace_id, configuration.workspaceId);
    assert.match(request.headers.get('anthropic-beta') ?? '', /oidc-federation/u);
    return new Response(
      JSON.stringify({
        access_token: 'sk-ant-oat01-offline',
        expires_in: 600,
        token_type: 'Bearer',
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  const credentials = createAnthropicGoogleCloudWorkloadIdentityCredentials({
    ...configuration,
    identityTokenProvider: () => 'header.payload.signature',
    tokenExchangeFetch: exchange.fetch,
  });

  const result = await credentials();
  assert.equal(result.token, 'sk-ant-oat01-offline');
  assert.equal(typeof result.expiresAt, 'number');
  assert.equal(exchange.calls.length, 1);
});

test('fails closed for incomplete or malformed federation identifiers', () => {
  assert.equal(isValidAnthropicGoogleCloudWorkloadIdentityConfiguration(configuration), true);
  for (const invalid of [
    { ...configuration, federationRuleId: '' },
    { ...configuration, federationRuleId: 'fdrl_' },
    { ...configuration, organizationId: 'not-an-organization-id' },
    { ...configuration, serviceAccountId: 'svac_' },
    { ...configuration, serviceAccountId: 'service-account' },
    { ...configuration, workspaceId: 'workspace' },
  ]) {
    assert.equal(isValidAnthropicGoogleCloudWorkloadIdentityConfiguration(invalid), false);
    assert.throws(
      () => createAnthropicGoogleCloudWorkloadIdentityCredentials(invalid),
      /configuration is invalid/u,
    );
  }
});
