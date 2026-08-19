import {
  geminiVertexDeploymentReadinessInputFromEnvironment,
  inspectGeminiVertexDeploymentReadiness,
} from '../services/ai/gemini-vertex-deployment-readiness';

const readiness = inspectGeminiVertexDeploymentReadiness(
  geminiVertexDeploymentReadinessInputFromEnvironment(process.env),
);

process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);

if (readiness.status === 'CONFIGURATION_INCOMPLETE') {
  process.exitCode = 1;
}
