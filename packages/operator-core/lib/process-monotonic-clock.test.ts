import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { processMonotonicClock } from './process-monotonic-clock';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

// Use the recorder's real TSX loader: Vitest's module cache unifies these paths
// and would conceal the CommonJS/ESM split seen by the gateway in production.
async function readMixedLoaderClock() {
  const script = `
    import { processMonotonicClock as direct } from './packages/operator-core/lib/process-monotonic-clock';
    (async () => {
      const module = await import('./packages/operator-core/lib/process-monotonic-clock.ts');
      const dynamic = module.processMonotonicClock ?? module.default.processMonotonicClock;
      console.log(JSON.stringify({ directId: direct.id, dynamicId: dynamic.id,
        sameObject: direct === dynamic, frozen: Object.isFrozen(direct),
        directNow: direct.now(), dynamicNow: dynamic.now() }));
    })();
  `;
  const { stdout } = await run(path.join(root, 'node_modules/.bin/tsx'), ['-e', script], {
    cwd: root, timeout: 15_000,
  });
  return JSON.parse(stdout.trim());
}

describe('process monotonic clock runtime identity', () => {
  it('shares the immutable clock across static CommonJS and dynamic ESM imports', async () => {
    const result = await readMixedLoaderClock();
    expect(result.sameObject).toBe(true);
    expect(result.dynamicId).toBe(result.directId);
    expect(result.frozen).toBe(true);
    expect(result.directNow).toBeGreaterThanOrEqual(0);
    expect(result.dynamicNow).toBeGreaterThanOrEqual(result.directNow);
  });

  it('keeps separately launched processes in distinct clock domains', async () => {
    const [first, second] = await Promise.all([readMixedLoaderClock(), readMixedLoaderClock()]);
    expect(first.directId).not.toBe(second.directId);
    expect(first.directId).not.toBe(processMonotonicClock.id);
    expect(second.directId).not.toBe(processMonotonicClock.id);
  });
});
