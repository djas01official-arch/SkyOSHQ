import { execFileSync } from 'node:child_process';
import path from 'node:path';

const allowedSecretLikeFiles = new Set(['.env.example']);

const generatedPathPatterns = [
  /(^|\/)\.next\//u,
  /(^|\/)\.turbo\//u,
  /(^|\/)coverage\//u,
  /(^|\/)database\/generated\//u,
  /(^|\/)\.skyos\//u,
  /(^|\/)\.workers?\//u,
  /(^|\/)parser-output\//u,
  /(^|\/)(tmp|temp)\//u,
  /\.log$/u,
  /\.tmp$/u,
  /\.tsbuildinfo$/u,
];

const secretFilePatterns = [
  /(^|\/)\.env($|\.)/u,
  /(^|\/)(id_rsa|id_ed25519)$/u,
  /\.(key|pem|p12|pfx)$/u,
  /(^|\/)(credentials?|secrets?)\.(json|ya?ml|toml)$/u,
];

function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return output
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replaceAll(path.sep, '/'));
}

const violations = trackedFiles().filter((file) => {
  if (generatedPathPatterns.some((pattern) => pattern.test(file))) {
    return true;
  }

  const basename = file.slice(file.lastIndexOf('/') + 1);
  return (
    !allowedSecretLikeFiles.has(basename) &&
    secretFilePatterns.some((pattern) => pattern.test(file))
  );
});

if (violations.length > 0) {
  console.error(
    [
      'Repository hygiene check failed. Remove these generated or secret-like files from Git:',
      ...violations.map((file) => `- ${file}`),
    ].join('\n'),
  );
  process.exitCode = 1;
} else {
  console.log('Repository hygiene check passed.');
}
