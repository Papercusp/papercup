import { resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { prepareRuntimeReader } from '../vitest.e2e.config';

describe('operator e2e config loading', () => {
  it.each(['', 'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json'])(
    'loads the optional runtime reader without bundling operator PG code (profile=%s)', async (profile) => {
      vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE', profile);
      try {
        const loaded = await loadConfigFromFile(
          { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, '../vitest.e2e.config.ts'),
        );
        expect(loaded).not.toBeNull();
        expect(loaded!.config.test?.provide?.papercuspTestLayer).toBe('e2e');
        expect(loaded!.dependencies.some(path => /runtime-vintage\.ts$/.test(path))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('finishes loader preparation before returning a reader and reuses it for both observations', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    const listRuntimeVintage = vi.fn(async () => []);
    const measureRuntimeVintageEnvironment = vi.fn(() => 'a'.repeat(64));
    let release!: (value: Record<string, unknown>) => void;
    const load = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    try {
      let prepared = false;
      const preparation = prepareRuntimeReader(load).then(reader => { prepared = true; return reader; });
      await Promise.resolve();
      expect(prepared).toBe(false);
      expect(listRuntimeVintage).not.toHaveBeenCalled();
      release({ listRuntimeVintage, measureRuntimeVintageEnvironment });
      const reader = await preparation;
      expect(await reader!()).toMatchObject({ fingerprint: 'a'.repeat(64) });
      expect(await reader!()).toMatchObject({ fingerprint: 'a'.repeat(64) });
      expect(load).toHaveBeenCalledTimes(1);
      expect(listRuntimeVintage).toHaveBeenCalledTimes(2);
      expect(measureRuntimeVintageEnvironment).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
  });
});
