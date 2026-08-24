import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

test('runtime image starts the standalone web server directly without pnpm', () => {
  assert.match(
    dockerfile,
    /CMD \["node", "apps\/web\/\.next\/standalone\/apps\/web\/server\.js"\]/,
  );
  assert.doesNotMatch(dockerfile, /CMD \["pnpm", "start:web"\]/);
});
