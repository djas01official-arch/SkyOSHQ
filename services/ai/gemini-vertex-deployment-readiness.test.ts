import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  geminiVertexDeploymentReadinessInputFromEnvironment,
  inspectGeminiVertexDeploymentReadiness,
} from './gemini-vertex-deployment-readiness';
import { resolveGeminiTransportConfig } from './gemini-language-model-provider';
import { LanguageModelProviderError } from './language-model-provider';

const VERTEX_INPUT = {
  model: 'gemini-3.6-flash',
  transport: 'vertex',
  vertexLocation: 'global',
  vertexProject: 'skyos-test-project',
} as const;

const UNVERIFIED_EXTERNAL_CHECKS = {
  adc: 'UNVERIFIED',
  billing: 'UNVERIFIED',
  iam: 'UNVERIFIED',
  modelAvailability: 'UNVERIFIED',
  project: 'UNVERIFIED',
  vertexApi: 'UNVERIFIED',
} as const;

test('developer selection and absent transport report that Vertex is not selected', () => {
  for (const input of [{}, { model: 'gemini-3.6-flash', transport: 'developer' }]) {
    const readiness = inspectGeminiVertexDeploymentReadiness(input);
    assert.equal(readiness.status, 'NOT_VERTEX_SELECTED');
    assert.equal(readiness.transport, 'developer');
    assert.equal(readiness.localConfiguration.status, 'NOT_VERTEX_SELECTED');
    assert.equal(readiness.localConfiguration.projectConfigured, false);
    assert.equal(readiness.localConfiguration.locationConfigured, false);
    assert.deepEqual(readiness.externalChecks, UNVERIFIED_EXTERNAL_CHECKS);
    assert.equal(readiness.liveSmoke, 'NOT_RUN');
  }
});

test('explicit SkyOS developer transport is not changed by ambient Google configuration', () => {
  const input = geminiVertexDeploymentReadinessInputFromEnvironment({
    AI_MODEL: 'gemini-3.6-flash',
    GEMINI_TRANSPORT: 'developer',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_CLOUD_PROJECT: 'skyos-test-project',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
  });
  const readiness = inspectGeminiVertexDeploymentReadiness(input);

  assert.equal(readiness.status, 'NOT_VERTEX_SELECTED');
  assert.equal(readiness.transport, 'developer');
  assert.equal(readiness.localConfiguration.projectConfigured, false);
  assert.equal(readiness.localConfiguration.locationConfigured, false);
});

test('explicit Vertex configuration is locally complete without a Gemini API key', () => {
  const readiness = inspectGeminiVertexDeploymentReadiness(VERTEX_INPUT);

  assert.equal(readiness.status, 'READY_FOR_EXTERNAL_VERIFICATION');
  assert.equal(readiness.transport, 'vertex');
  assert.equal(readiness.configuredModel, 'gemini-3.6-flash');
  assert.deepEqual(readiness.localConfiguration, {
    approvedModelConfigured: true,
    locationConfigured: true,
    projectConfigured: true,
    status: 'COMPLETE',
  });
  assert.deepEqual(readiness.externalChecks, UNVERIFIED_EXTERNAL_CHECKS);
  assert.equal(readiness.liveSmoke, 'NOT_RUN');
});

test('Vertex readiness fails closed for missing project, location, or approved model', () => {
  for (const input of [
    { ...VERTEX_INPUT, vertexProject: '   ' },
    { ...VERTEX_INPUT, vertexLocation: '   ' },
    { ...VERTEX_INPUT, model: 'unapproved-model' },
  ]) {
    const readiness = inspectGeminiVertexDeploymentReadiness(input);
    assert.equal(readiness.status, 'CONFIGURATION_INCOMPLETE');
    assert.equal(readiness.transport, 'vertex');
    assert.equal(readiness.localConfiguration.status, 'INCOMPLETE');
    assert.deepEqual(readiness.externalChecks, UNVERIFIED_EXTERNAL_CHECKS);
    assert.equal(readiness.liveSmoke, 'NOT_RUN');
  }
});

test('invalid transport stays fail-closed through the existing Gemini resolver', () => {
  assert.throws(
    () => resolveGeminiTransportConfig({ transport: 'not-a-skyos-transport' }),
    (error: unknown) =>
      error instanceof LanguageModelProviderError &&
      error.code === 'provider_configuration_invalid',
  );
  const readiness = inspectGeminiVertexDeploymentReadiness({
    ...VERTEX_INPUT,
    transport: 'not-a-skyos-transport',
  });
  assert.equal(readiness.status, 'CONFIGURATION_INCOMPLETE');
  assert.equal(readiness.transport, 'invalid');
  assert.equal(readiness.localConfiguration.status, 'INCOMPLETE');
});

test('environment mapping reads only SkyOS-owned non-secret configuration names', () => {
  const input = geminiVertexDeploymentReadinessInputFromEnvironment({
    AI_MODEL: 'gemini-3.6-flash',
    GEMINI_API_KEY: 'must-not-be-read',
    GEMINI_TRANSPORT: 'vertex',
    GOOGLE_APPLICATION_CREDENTIALS: 'must-not-be-read',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_CLOUD_PROJECT: 'skyos-test-project',
    GOOGLE_GENAI_USE_VERTEXAI: 'false',
  });

  assert.deepEqual(input, VERTEX_INPUT);
  const readiness = inspectGeminiVertexDeploymentReadiness(input);
  const serialized = JSON.stringify(readiness);
  assert.equal(serialized.includes('skyos-test-project'), false);
  assert.equal(serialized.includes('must-not-be-read'), false);
  assert.equal(serialized.includes('GOOGLE_GENAI_USE_VERTEXAI'), false);
});

test('readiness reports the approved model without claiming Vertex availability', () => {
  const readiness = inspectGeminiVertexDeploymentReadiness(VERTEX_INPUT);
  assert.equal(readiness.configuredModel, 'gemini-3.6-flash');
  assert.equal(readiness.externalChecks.modelAvailability, 'UNVERIFIED');
  assert.equal(readiness.liveSmoke, 'NOT_RUN');
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.externalChecks), true);
});

test('readiness inspection has no provider, credential, network, or database dependency', () => {
  const readiness = inspectGeminiVertexDeploymentReadiness(VERTEX_INPUT);
  assert.deepEqual(Object.keys(readiness).sort(), [
    'configuredModel',
    'externalChecks',
    'liveSmoke',
    'localConfiguration',
    'status',
    'transport',
  ]);
  assert.deepEqual(Object.keys(readiness.externalChecks).sort(), [
    'adc',
    'billing',
    'iam',
    'modelAvailability',
    'project',
    'vertexApi',
  ]);
});
