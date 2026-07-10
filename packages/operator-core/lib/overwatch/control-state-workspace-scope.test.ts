/**
 * control-state-workspace-scope.test.ts — P-004 (workspace-scoped-coordination-2026-06-20,
 * D-006/D-007 — Phase C, the OVERWATCH re-key, a direct mirror of the Queen's
 * Phase A in hive/started-workspace-scope.test.ts and the Scout's Phase P-002):
 * the K1 workspace-sentinel re-key of the Start/Pause-Overwatch state + cadence +
 * the de-duped Overwatch-supervisor set, gated on FLAGS.WORKSPACE_COORDINATION.
 *
 *   - getOverwatchStarted / setOverwatchStarted / getOverwatchCadenceSec /
 *     setOverwatchCadenceSec: ON ⇒ the control state collapses to ONE row per
 *     workspace under the sentinel (key install dimension = workspaceId), with a
 *     READ-FALLBACK to the legacy per-hive row; OFF ⇒ the per-(ws,install) row,
 *     BYTE-IDENTICAL to today.
 *   - listStartedWorkspaceOverwatches: ON ⇒ ONE entry per started workspace (the
 *     supervisor the watchdog boot/sweep runs once); OFF ⇒ the raw per-hive set,
 *     byte-identical to listStartedOverwatches.
 *
 * Hermetic: the PG/flag edges are mocked, so this pins the KEYING DECISION (not
 * the DB) — the Overwatch-side companion to hive/started-workspace-scope.test.ts's
 * Queen coverage. The pure sentinel math itself is covered in
 * ../workspace-brain-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  // The fake operator_settings KV: key → 'true' | 'false' | '<int>'.
  kv: new Map<string, string>(),
  upserts: [] as Array<{ key: string; value: string }>,
  bulkUpdates: [] as Array<{ prefix: string; excludedKey: string; value: string }>,
  registeredHives: [] as string[],
}));

// A fake tagged-template SQL that reads/writes h.kv by statement text + bound key.
const fakeSql = (strings: TemplateStringsArray | string[], ...values: unknown[]): Promise<unknown[]> => {
  const text = Array.isArray(strings) ? strings.join('?') : String(strings);
  if (/INSERT INTO harness_shared\.operator_settings/i.test(text)) {
    const [key, value] = values as [string, string];
    h.kv.set(key, value);
    h.upserts.push({ key, value });
    return Promise.resolve([]);
  }
  if (/UPDATE harness_shared\.operator_settings/i.test(text)) {
    const [value, , , likePattern, excludedKey] = values as [string, string, number, string, string];
    const prefix = likePattern.endsWith('%') ? likePattern.slice(0, -1) : likePattern;
    for (const key of h.kv.keys()) {
      if (key.startsWith(prefix) && key !== excludedKey) h.kv.set(key, value);
    }
    h.bulkUpdates.push({ prefix, excludedKey, value });
    return Promise.resolve([]);
  }
  if (/SELECT value FROM harness_shared\.operator_settings WHERE key = /i.test(text)) {
    // single-key read: SELECT value ... WHERE key = ${key} LIMIT 1
    const key = values[0] as string;
    const v = h.kv.get(key);
    return Promise.resolve(v != null ? [{ value: v }] : []);
  }
  if (/SELECT key FROM harness_shared\.operator_settings\s+WHERE key LIKE /i.test(text)) {
    // listStartedOverwatches scan: SELECT key ... WHERE key LIKE 'overwatch_started:%' AND value='true'
    const out = [...h.kv.entries()]
      .filter(([k, v]) => k.startsWith('overwatch_started:') && v === 'true')
      .map(([k]) => ({ key: k }));
    return Promise.resolve(out);
  }
  return Promise.resolve([]);
};

vi.mock('@papercusp/db-org', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: fakeSql }) };
});
// Keep the REAL pure sentinel math; only stub the flag read.
vi.mock('../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: h.registeredHives.map((slug) => ({ slug, harness_kind: 'hive' })),
  })),
}));

import {
  getOverwatchStarted,
  setOverwatchStarted,
  getOverwatchCadenceSec,
  setOverwatchCadenceSec,
  listStartedOverwatches,
  listStartedWorkspaceOverwatches,
  DEFAULT_OVERWATCH_CADENCE_SEC,
} from './control-state';

const WS = 'papercusp-workspace';
const HIVE = 'papercusp';

beforeEach(() => {
  h.kv.clear();
  h.upserts.length = 0;
  h.bulkUpdates.length = 0;
  h.registeredHives = ['papercusp', 'hive-a', 'hive-b', 'hive-x', 'other-ws'];
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  delete process.env.PAPERCUSP_POT_HOME_SLUG;
});

describe('setOverwatchStarted — K1 workspace-sentinel write key (P-004)', () => {
  it('flag OFF → writes the legacy per-(ws,install) row (byte-identical to today)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await setOverwatchStarted(WS, HIVE, true);
    expect(h.upserts).toEqual([{ key: `overwatch_started:${WS}:${HIVE}`, value: 'true' }]);
  });

  it('flag ON → writes the workspace-sentinel row and converges the legacy fallback row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await setOverwatchStarted(WS, HIVE, true);
    expect(h.upserts).toEqual([
      { key: `overwatch_started:${WS}:${WS}`, value: 'true' },
      { key: `overwatch_started:${WS}:${HIVE}`, value: 'true' },
    ]);
  });

  it('flag ON + pause → clears stale legacy true rows so the watchdog cannot split-brain', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_started:${WS}:old-hive-a`, 'true');
    h.kv.set(`overwatch_started:${WS}:old-hive-b`, 'true');
    h.kv.set(`overwatch_started:other-ws:old-hive`, 'true');

    await setOverwatchStarted(WS, HIVE, false);

    expect(h.kv.get(`overwatch_started:${WS}:${WS}`)).toBe('false');
    expect(h.kv.get(`overwatch_started:${WS}:${HIVE}`)).toBe('false');
    expect(h.kv.get(`overwatch_started:${WS}:old-hive-a`)).toBe('false');
    expect(h.kv.get(`overwatch_started:${WS}:old-hive-b`)).toBe('false');
    expect(h.kv.get(`overwatch_started:other-ws:old-hive`)).toBe('true');
    expect(h.bulkUpdates).toEqual([
      {
        prefix: `overwatch_started:${WS}:`,
        excludedKey: `overwatch_started:${WS}:${WS}`,
        value: 'false',
      },
    ]);
  });
});

describe('getOverwatchStarted — K1 read-fallback (P-004)', () => {
  it('flag OFF → reads only the per-hive row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.kv.set(`overwatch_started:${WS}:${HIVE}`, 'true');
    expect(await getOverwatchStarted(WS, HIVE)).toBe(true);
    // a sentinel row must be IGNORED when off (no widening)
    h.kv.clear();
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    expect(await getOverwatchStarted(WS, HIVE)).toBe(false);
  });

  it('flag ON → prefers the sentinel row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    expect(await getOverwatchStarted(WS, HIVE)).toBe(true);
  });

  it('flag ON, no sentinel yet → FALLS BACK to the legacy per-hive row (zero regression)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_started:${WS}:${HIVE}`, 'true'); // only the legacy row exists
    expect(await getOverwatchStarted(WS, HIVE)).toBe(true);
  });

  it('flag ON → the sentinel started bit resolves for ANY hive in the workspace (central-supervisor widening)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    expect(await getOverwatchStarted(WS, 'another-hive')).toBe(true);
  });

  it('default false when no row exists (both modes)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    expect(await getOverwatchStarted(WS, HIVE)).toBe(false);
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    expect(await getOverwatchStarted(WS, HIVE)).toBe(false);
  });
});

describe('cadence — K1 sentinel write + read-fallback (P-004)', () => {
  it('flag OFF → writes + reads the legacy per-hive row (byte-identical)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await setOverwatchCadenceSec(WS, HIVE, 300);
    expect(h.upserts).toEqual([{ key: `overwatch_cadence_sec:${WS}:${HIVE}`, value: '300' }]);
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(300);
    // a sentinel cadence row is IGNORED when off
    h.kv.clear();
    h.kv.set(`overwatch_cadence_sec:${WS}:${WS}`, '300');
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
  });

  it('flag ON → writes the sentinel row + prefers it on read', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await setOverwatchCadenceSec(WS, HIVE, 300);
    expect(h.upserts).toEqual([{ key: `overwatch_cadence_sec:${WS}:${WS}`, value: '300' }]);
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(300);
  });

  it('flag ON, no sentinel yet → FALLS BACK to the legacy per-hive cadence (zero regression)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_cadence_sec:${WS}:${HIVE}`, '300'); // only the legacy row exists
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(300);
  });

  it('default when unset (both modes)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    expect(await getOverwatchCadenceSec(WS, HIVE)).toBe(DEFAULT_OVERWATCH_CADENCE_SEC);
  });
});

describe('listStartedOverwatches — raw per-hive set (pane resolver, UNCHANGED)', () => {
  it('flag OFF or ON → the raw rows (byte-identical; the pane resolver keeps real slugs)', async () => {
    h.kv.set(`overwatch_started:${WS}:hive-a`, 'true');
    h.kv.set(`overwatch_started:${WS}:hive-b`, 'true');
    h.kv.set(`overwatch_started:${WS}:hive-c`, 'false'); // not started
    h.isWorkspaceCoordinationOn.mockResolvedValue(true); // listStartedOverwatches never collapses
    const rows = await listStartedOverwatches();
    expect(rows).toEqual([
      { workspaceId: WS, installSlug: 'hive-a' },
      { workspaceId: WS, installSlug: 'hive-b' },
    ]);
  });
});

describe('listStartedWorkspaceOverwatches — de-duped supervisor set (P-004)', () => {
  it('flag OFF → the raw per-hive set (byte-identical to listStartedOverwatches)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.kv.set(`overwatch_started:${WS}:hive-a`, 'true');
    h.kv.set(`overwatch_started:${WS}:hive-b`, 'true');
    expect(await listStartedWorkspaceOverwatches()).toEqual([
      { workspaceId: WS, installSlug: 'hive-a' },
      { workspaceId: WS, installSlug: 'hive-b' },
    ]);
  });

  it('flag ON → ONE supervisor per workspace, seated at the env home hive', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = HIVE;
    // Two hives started in the same workspace (sentinel + a stray legacy row).
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    h.kv.set(`overwatch_started:${WS}:hive-b`, 'true');
    expect(await listStartedWorkspaceOverwatches()).toEqual([{ workspaceId: WS, installSlug: HIVE }]);
  });

  it("flag ON, no env home → seats at the first row's install (multi-home pre-flip stays sane)", async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`overwatch_started:${WS}:hive-x`, 'true');
    expect(await listStartedWorkspaceOverwatches()).toEqual([{ workspaceId: WS, installSlug: 'hive-x' }]);
  });

  it('flag ON → distinct workspaces each get exactly one supervisor', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = HIVE;
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    h.kv.set(`overwatch_started:other-ws:other-ws`, 'true');
    const loops = await listStartedWorkspaceOverwatches();
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.workspaceId).sort()).toEqual(['other-ws', WS].sort());
  });

  it('flag ON → rejects a dead env seat and falls back to a registered started hive', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = 'deleted-home';
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    h.kv.set(`overwatch_started:${WS}:hive-b`, 'true');
    expect(await listStartedWorkspaceOverwatches()).toEqual([{ workspaceId: WS, installSlug: 'hive-b' }]);
  });

  it('flag ON → omits a workspace with only an unregistered sentinel row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.registeredHives = [];
    h.kv.set(`overwatch_started:${WS}:${WS}`, 'true');
    expect(await listStartedWorkspaceOverwatches()).toEqual([]);
  });
});
