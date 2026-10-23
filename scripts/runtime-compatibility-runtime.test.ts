import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUNTIME_EXPECTATIONS, performRuntimeCapability } from './lib/runtime-compatibility-probes.mjs';
import { measureRuntime, runCapability } from './lib/runtime-compatibility.mjs';

const probePath = fileURLToPath(new URL('./lib/runtime-compatibility-probes.mjs', import.meta.url));
const candidate = { sourceSha: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
  configurationSha256: 'c'.repeat(64), dependencyGeneration: 'runtime-source-test-fixture' };

describe('isolated runtime protocol semantics', () => {
  it.each(Object.keys(RUNTIME_EXPECTATIONS))('%s completes with the measured interpreter', async id => {
    const runtime = await measureRuntime(process.execPath);
    const result = await runCapability({ capabilityId: id, expected: RUNTIME_EXPECTATIONS[id],
      runtime, candidate, probePath }, { timeoutMs: 8_000, env: { PAPERCUSP_PROBE_CAPABILITY: id } });
    expect({ status: result.status, actual: result.actual, reasons: result.reasons })
      .toEqual({ status: 'passed', actual: RUNTIME_EXPECTATIONS[id], reasons: [] });
  }, 15_000);
  it('refuses an unknown protocol instead of completing a substitute operation', async () => {
    await expect(performRuntimeCapability('unknown')).rejects.toThrow('Unknown runtime capability');
  });
});
