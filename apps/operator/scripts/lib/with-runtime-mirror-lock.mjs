#!/usr/bin/env node
// Serialize a generated runtime mirror across install and prebuild callers.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

const [destination, script] = process.argv.slice(2);
if (!destination || !script) throw new Error('Expected a mirror destination and setup script');
const mirror = resolve(destination);
const key = 'runtime-mirror-' + createHash('sha256').update(mirror).digest('hex').slice(0, 20);
const result = await withFsMutex(key, async () => spawnSync('bash', [resolve(script)], {
  stdio: 'inherit',
  env: { ...process.env, PAPERCUSP_RUNTIME_MIRROR_LOCK: mirror },
}), {
  intent: 'Regenerate runtime mirror ' + mirror,
  onWaiting: () => console.error('runtime-mirror: waiting for another mirror transaction'),
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
