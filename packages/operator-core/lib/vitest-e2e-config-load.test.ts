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
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    let release!: (value: Record<string, unknown>) => void;
    const load = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    try {
      let prepared = false;
      const preparation = prepareRuntimeReader(load, async () => pg as any)
        .then(reader => { prepared = true; return reader; });
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
      expect(sql.end).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reads runtime witnesses from the reporter ledger instead of an embedded app database', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://ledger.test:5432/papercusp');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://embedded.test:24680/papercusp');
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    const rows = [{ unit: 'actual-live-runtime' }];
    const listRuntimeVintage = vi.fn(async (_workspace, client) => {
      expect(client).toBe(sql);
      return rows;
    });
    const measureRuntimeVintageEnvironment = vi.fn(() => 'b'.repeat(64));
    try {
      const reader = await prepareRuntimeReader(async () => ({
        listRuntimeVintage, measureRuntimeVintageEnvironment,
      }), async () => pg as any);
      expect(await reader!()).toMatchObject({ fingerprint: 'b'.repeat(64) });
      expect(pg).toHaveBeenCalledWith('postgresql://ledger.test:5432/papercusp', expect.any(Object));
      expect(listRuntimeVintage).toHaveBeenCalledWith(undefined, sql, expect.any(Array));
      expect(measureRuntimeVintageEnvironment).toHaveBeenCalledWith(rows, expect.any(Array));
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally { vi.unstubAllEnvs(); }
  });

  it('closes the observation client when the runtime ledger read fails', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    try {
      const reader = await prepareRuntimeReader(async () => ({
        listRuntimeVintage: async () => { throw new Error('runtime ledger unavailable'); },
        measureRuntimeVintageEnvironment: vi.fn(),
      }), async () => pg as any);
      await expect(reader!()).rejects.toThrow('runtime ledger unavailable');
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally { vi.unstubAllEnvs(); }
  });
});
