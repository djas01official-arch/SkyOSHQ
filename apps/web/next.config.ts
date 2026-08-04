import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';
import type { NextConfig } from 'next';

// Next runs this workspace from apps/web; SkyOS keeps local configuration at the monorepo root.
loadEnvironment({ path: resolve(process.cwd(), '../../.env') });

const nextConfig: NextConfig = {
  serverExternalPackages: ['argon2'],
};

export default nextConfig;
