import {
  GEMINI_APPROVED_MODELS,
  resolveGeminiTransportConfig,
} from './gemini-language-model-provider';

export type GeminiVertexDeploymentReadinessStatus =
  'CONFIGURATION_INCOMPLETE' | 'NOT_VERTEX_SELECTED' | 'READY_FOR_EXTERNAL_VERIFICATION';

export type GeminiVertexLocalConfigurationStatus =
  'COMPLETE' | 'INCOMPLETE' | 'NOT_VERTEX_SELECTED';

export type GeminiVertexExternalCheckStatus = 'UNVERIFIED';

export type GeminiVertexDeploymentReadinessInput = Readonly<{
  model?: string;
  transport?: string;
  vertexLocation?: string;
  vertexProject?: string;
}>;

export type GeminiVertexDeploymentReadinessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type GeminiVertexDeploymentReadiness = Readonly<{
  configuredModel?: string;
  externalChecks: Readonly<{
    adc: GeminiVertexExternalCheckStatus;
    billing: GeminiVertexExternalCheckStatus;
    iam: GeminiVertexExternalCheckStatus;
    modelAvailability: GeminiVertexExternalCheckStatus;
    project: GeminiVertexExternalCheckStatus;
    vertexApi: GeminiVertexExternalCheckStatus;
  }>;
  liveSmoke: 'NOT_RUN';
  localConfiguration: Readonly<{
    approvedModelConfigured: boolean;
    locationConfigured: boolean;
    projectConfigured: boolean;
    status: GeminiVertexLocalConfigurationStatus;
  }>;
  status: GeminiVertexDeploymentReadinessStatus;
  transport: 'developer' | 'invalid' | 'vertex';
}>;

export const GEMINI_VERTEX_EXTERNAL_READINESS_CHECKLIST = Object.freeze([
  'Google Cloud project exists.',
  'Project billing is enabled.',
  'Vertex AI API (aiplatform.googleapis.com) is enabled.',
  'Runtime or operator Application Default Credentials are available.',
  'Runtime principal has sufficient Vertex prediction/use permission.',
  'Configured model availability is verified for the selected project and location.',
  'An isolated live smoke test is separately approved.',
] as const);

const EXTERNAL_CHECKS = Object.freeze({
  adc: 'UNVERIFIED',
  billing: 'UNVERIFIED',
  iam: 'UNVERIFIED',
  modelAvailability: 'UNVERIFIED',
  project: 'UNVERIFIED',
  vertexApi: 'UNVERIFIED',
} as const);

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function report(
  status: GeminiVertexDeploymentReadinessStatus,
  transport: GeminiVertexDeploymentReadiness['transport'],
  localConfiguration: GeminiVertexDeploymentReadiness['localConfiguration'],
  configuredModel?: string,
): GeminiVertexDeploymentReadiness {
  return Object.freeze({
    ...(configuredModel ? { configuredModel } : {}),
    externalChecks: EXTERNAL_CHECKS,
    liveSmoke: 'NOT_RUN',
    localConfiguration,
    status,
    transport,
  });
}

/**
 * Maps only the SkyOS-owned, non-secret configuration names. Ambient Google
 * SDK selectors and credential variables deliberately cannot select Vertex.
 */
export function geminiVertexDeploymentReadinessInputFromEnvironment(
  environment: GeminiVertexDeploymentReadinessEnvironment,
): GeminiVertexDeploymentReadinessInput {
  return Object.freeze({
    model: environment.AI_MODEL,
    transport: environment.GEMINI_TRANSPORT,
    vertexLocation: environment.GOOGLE_CLOUD_LOCATION,
    vertexProject: environment.GOOGLE_CLOUD_PROJECT,
  });
}

/**
 * Inspects only repository-local Vertex readiness. It never constructs a
 * provider client, reads credentials, contacts Google, or writes database
 * state. External provisioning and model availability always remain unverified.
 */
export function inspectGeminiVertexDeploymentReadiness(
  input: GeminiVertexDeploymentReadinessInput,
): GeminiVertexDeploymentReadiness {
  const transport = normalized(input.transport)?.toLowerCase();
  const model = normalized(input.model);
  const approvedModelConfigured =
    model !== undefined && (GEMINI_APPROVED_MODELS as readonly string[]).includes(model);
  const projectConfigured = normalized(input.vertexProject) !== undefined;
  const locationConfigured = normalized(input.vertexLocation) !== undefined;

  if (transport === undefined || transport === 'developer') {
    return report(
      'NOT_VERTEX_SELECTED',
      'developer',
      Object.freeze({
        approvedModelConfigured,
        locationConfigured: false,
        projectConfigured: false,
        status: 'NOT_VERTEX_SELECTED',
      }),
      approvedModelConfigured ? model : undefined,
    );
  }

  if (transport !== 'vertex') {
    try {
      resolveGeminiTransportConfig({ transport: input.transport });
    } catch {
      // The existing Gemini transport resolver owns invalid-selection semantics.
    }
    return report(
      'CONFIGURATION_INCOMPLETE',
      'invalid',
      Object.freeze({
        approvedModelConfigured,
        locationConfigured,
        projectConfigured,
        status: 'INCOMPLETE',
      }),
      approvedModelConfigured ? model : undefined,
    );
  }

  try {
    resolveGeminiTransportConfig({
      transport: 'vertex',
      vertexLocation: input.vertexLocation,
      vertexProject: input.vertexProject,
    });
  } catch {
    return report(
      'CONFIGURATION_INCOMPLETE',
      'vertex',
      Object.freeze({
        approvedModelConfigured,
        locationConfigured,
        projectConfigured,
        status: 'INCOMPLETE',
      }),
      approvedModelConfigured ? model : undefined,
    );
  }

  if (!approvedModelConfigured) {
    return report(
      'CONFIGURATION_INCOMPLETE',
      'vertex',
      Object.freeze({
        approvedModelConfigured: false,
        locationConfigured,
        projectConfigured,
        status: 'INCOMPLETE',
      }),
    );
  }

  return report(
    'READY_FOR_EXTERNAL_VERIFICATION',
    'vertex',
    Object.freeze({
      approvedModelConfigured: true,
      locationConfigured,
      projectConfigured,
      status: 'COMPLETE',
    }),
    model,
  );
}
