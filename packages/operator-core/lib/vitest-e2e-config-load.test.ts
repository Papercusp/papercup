import { resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';
import { describe, expect, it, vi } from 'vitest';

describe('operator e2e config loading', () => {
  it.each(['', 'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json'])(
    'loads the optional runtime reader without eagerly importing operator PG code (profile=%s)', async (profile) => {
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
});
