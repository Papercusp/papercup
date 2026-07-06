/**
 * started-workspace-scope.test.ts — P-003 (workspace-scoped-coordination-2026-06-20,
 * D-006/D-007): the K1 workspace-sentinel re-key of the Start/Pause-Hive state +
 * the de-duped Queen-liveness loop set, gated on FLAGS.WORKSPACE_COORDINATION.
 *
 *   - getHiveStarted / setHiveStarted: ON ⇒ the started bit collapses to ONE row
 *     per workspace under the sentinel (key install dimension = workspaceId), with
 *     a READ-FALLBACK to the legacy per-hive row; OFF ⇒ the per-(ws,install) row,
 *     BYTE-IDENTICAL to today.
 *   - listStartedWorkspaceLoops: ON ⇒ ONE entry per started workspace (the
 *     liveness loop the watchdog/throughput sweep runs once); OFF ⇒ the raw
 *     per-hive set, byte-identical to listStartedHives.
 *
 * Hermetic: the PG/flag edges are mocked, so this pins the KEYING DECISION (not
 * the DB) — the Queen-side companion to scheduler-workspace-scope.ts's Scout
 * coverage. The pure sentinel math itself is covered in
 * ../workspace-brain-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  // The fake operator_settings KV: key → 'true' | 'false'.
  kv: new Map<string, string>(),
  upserts: [] as Array<{ key: string; value: string }>,
  // WI-3193: the set of CURRENTLY-REGISTERED kind:'hive' slugs the fake harness
  // registry reports. anyHivePlacementStarted now intersects the started rows with
  // this, so a stale started-row for an UNREGISTERED slug can't pin the loop alive.
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
  if (/WHERE key = /i.test(text)) {
    // single-key read: SELECT value ... WHERE key = ${key} LIMIT 1
    const key = values[0] as string;
    const v = h.kv.get(key);
    return Promise.resolve(v != null ? [{ value: v }] : []);
  }
  if (/WHERE key LIKE /i.test(text)) {
    // listStartedHives scan: SELECT key ... WHERE key LIKE 'hive_started:%' AND value='true'
    const out = [...h.kv.entries()]
      .filter(([k, v]) => k.startsWith('hive_started:') && v === 'true')
      .map(([k]) => ({ key: k }));
    return Promise.resolve(out);
  }
  return Promise.resolve([]);
};

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fakeSql }) }));
// Keep the REAL pure sentinel math; only stub the flag read.
vi.mock('../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
// WI-3193: fake harness registry so anyHivePlacementStarted's registered-hive
// intersection is deterministic — reports each slug in h.registeredHives as a
// kind:'hive' project (the only field the intersection reads).
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: h.registeredHives.map((slug) => ({ slug, harness_kind: 'hive' })),
  })),
}));

import {
  getHiveStarted,
  setHiveStarted,
  getHivePlacementStarted,
  setHivePlacementStarted,
  anyHivePlacementStarted,
  listStartedHives,
  listStartedWorkspaceLoops,
} from './started';

const WS = 'papercusp-workspace';
const HIVE = 'papercusp';

beforeEach(() => {
  h.kv.clear();
  h.upserts.length = 0;
  h.registeredHives = [];
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  delete process.env.PAPERCUSP_HIVE_HOME_SLUG;
});

describe('setHiveStarted — K1 workspace-sentinel write key (P-003)', () => {
  it('flag OFF → writes the legacy per-(ws,install) row (byte-identical to today)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await setHiveStarted(WS, HIVE, true);
    // WI-3261: every setHiveStarted call also writes the pause-provenance bit
    // (started:true always clears `deliberate`, regardless of caller).
    expect(h.upserts).toEqual([
      { key: `hive_started:${WS}:${HIVE}`, value: 'true' },
      { key: `hive_paused_deliberate:${WS}:${HIVE}`, value: 'false' },
    ]);
  });

  it('flag ON → writes the workspace-sentinel row (install dimension = workspaceId)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await setHiveStarted(WS, HIVE, true);
    // WI-3261: pause-provenance bit is scoped identically (workspace sentinel).
    expect(h.upserts).toEqual([
      { key: `hive_started:${WS}:${WS}`, value: 'true' },
      { key: `hive_paused_deliberate:${WS}:${WS}`, value: 'false' },
    ]);
  });
});

describe('getHiveStarted — K1 read-fallback (P-003)', () => {
  it('flag OFF → reads only the per-hive row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.kv.set(`hive_started:${WS}:${HIVE}`, 'true');
    expect(await getHiveStarted(WS, HIVE)).toBe(true);
    // a sentinel row must be IGNORED when off (no widening)
    h.kv.clear();
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    expect(await getHiveStarted(WS, HIVE)).toBe(false);
  });

  it('flag ON → prefers the sentinel row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    expect(await getHiveStarted(WS, HIVE)).toBe(true);
  });

  it('flag ON, no sentinel yet → FALLS BACK to the legacy per-hive row (zero regression)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:${HIVE}`, 'true'); // only the legacy row exists
    expect(await getHiveStarted(WS, HIVE)).toBe(true);
  });

  it('flag ON → the sentinel started bit resolves for ANY hive in the workspace (central-dispatch widening)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    expect(await getHiveStarted(WS, 'another-hive')).toBe(true);
  });

  it('default false when no row exists (both modes)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    expect(await getHiveStarted(WS, HIVE)).toBe(false);
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    expect(await getHiveStarted(WS, HIVE)).toBe(false);
  });
});

describe('listStartedHives — raw per-hive set (placement gate, UNCHANGED)', () => {
  it('flag OFF or ON → the raw rows (byte-identical; the per-hive placement gate keeps real slugs)', async () => {
    h.kv.set(`hive_started:${WS}:hive-a`, 'true');
    h.kv.set(`hive_started:${WS}:hive-b`, 'true');
    h.kv.set(`hive_started:${WS}:hive-c`, 'false'); // not started
    h.isWorkspaceCoordinationOn.mockResolvedValue(true); // listStartedHives never collapses
    const rows = await listStartedHives();
    expect(rows).toEqual([
      { workspaceId: WS, installSlug: 'hive-a' },
      { workspaceId: WS, installSlug: 'hive-b' },
    ]);
  });
});

describe('listStartedWorkspaceLoops — de-duped Queen-liveness loop (P-003)', () => {
  it('flag OFF → the raw per-hive set (byte-identical to listStartedHives)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.kv.set(`hive_started:${WS}:hive-a`, 'true');
    h.kv.set(`hive_started:${WS}:hive-b`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([
      { workspaceId: WS, installSlug: 'hive-a' },
      { workspaceId: WS, installSlug: 'hive-b' },
    ]);
  });

  it('flag ON → ONE loop per workspace, seated at the env home hive', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_HIVE_HOME_SLUG = HIVE;
    // Two hives started in the same workspace (sentinel + a stray legacy row).
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.kv.set(`hive_started:${WS}:hive-b`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([{ workspaceId: WS, installSlug: HIVE }]);
  });

  it('flag ON, no env home → seats at the first row\'s install (multi-home pre-flip stays sane)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:hive-x`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([{ workspaceId: WS, installSlug: 'hive-x' }]);
  });

  it('flag ON → distinct workspaces each get exactly one loop', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_HIVE_HOME_SLUG = HIVE;
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.kv.set(`hive_started:other-ws:other-ws`, 'true');
    const loops = await listStartedWorkspaceLoops();
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.workspaceId).sort()).toEqual(['other-ws', WS].sort());
  });
});

// ---------------------------------------------------------------------------
// Per-hive placement bit — the HONEST per-hive Start/Stop read/write (WI-1324,
// per-hive start-stop 2026-06-30). The bug: getHiveStarted is sentinel-first, so
// under WORKSPACE_COORDINATION every registered hive read the SAME workspace
// sentinel → the pill showed "N hives running" though all were dormant, and
// pot:pause wrote the shared sentinel (harness discarded) so "Stop hive X"
// stopped the whole workspace. getHivePlacementStarted / setHivePlacementStarted
// are the RAW per-(ws,install) row: they IGNORE the sentinel collapse entirely
// (no flag read), so each hive reports its own honest state and hive.controlState
// (which now reads getHivePlacementStarted) drives one honest control per hive.
// ---------------------------------------------------------------------------
describe('getHivePlacementStarted / setHivePlacementStarted — raw per-hive bit (WI-1324)', () => {
  it('reads the RAW per-hive row, IGNORING the workspace sentinel (kills the phantom "N running")', async () => {
    // Even with the collapse flag ON and the workspace sentinel started (the Queen
    // LOOP is running)...
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    // ...a hive with NO per-hive placement bit is NOT placed → reads false.
    expect(await getHivePlacementStarted(WS, 'forms')).toBe(false);
    expect(await getHivePlacementStarted(WS, 'sheets')).toBe(false);
  });

  it('writes the per-(ws,install) row REGARDLESS of the flag (harness never discarded)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true); // even with the collapse flag ON...
    await setHivePlacementStarted(WS, 'forms', true);
    // ...the write targets the REAL hive slug, not the sentinel row.
    expect(h.upserts).toEqual([{ key: `hive_started:${WS}:forms`, value: 'true' }]);
    expect(await getHivePlacementStarted(WS, 'forms')).toBe(true);
    expect(await getHivePlacementStarted(WS, 'sheets')).toBe(false); // a sibling stays untouched
  });

  it('"Stop hive X" flips ONLY X (round-trip): start two, stop one → the other stays started', async () => {
    await setHivePlacementStarted(WS, 'forms', true);
    await setHivePlacementStarted(WS, 'sheets', true);
    await setHivePlacementStarted(WS, 'forms', false); // "Stop hive forms"
    expect(await getHivePlacementStarted(WS, 'forms')).toBe(false);
    expect(await getHivePlacementStarted(WS, 'sheets')).toBe(true);
  });

  it('default false when the hive was never started per-hive', async () => {
    expect(await getHivePlacementStarted(WS, 'never-started')).toBe(false);
  });
});

describe('anyHivePlacementStarted — the sentinel-idle gate for pot:pause (WI-1324)', () => {
  // pot:pause idles the workspace Queen LOOP (sentinel off) ONLY when NO OTHER
  // hive remains started (excludeSlug = the just-stopped hive), so the single loop
  // keeps running for the other started hives.
  it('true when another REGISTERED hive remains started → keep the workspace loop running', async () => {
    h.registeredHives = ['forms', 'sheets'];
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true');
    // Stopping `forms` — `sheets` is still started AND registered.
    expect(await anyHivePlacementStarted(WS, 'forms')).toBe(true);
  });

  // WI-3193 recurrence guard (owner-reported "I clicked Stop and it kept running"):
  // a stale started-row for a hive NO LONGER in the registry must NOT keep the loop
  // alive, else pot:pause can never idle the workspace Queen (sentinel stays true →
  // watchdog re-arms the wake ~30s later; the declare_wake paused-gate never trips).
  it('false when the only other started row is a STALE UNREGISTERED slug → idle the loop', async () => {
    h.registeredHives = ['forms']; // `sheets` was dissolved/never-registered
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true'); // stale leftover row
    // Stopping `forms` — `sheets` is started in the KV but is NOT a registered hive.
    expect(await anyHivePlacementStarted(WS, 'forms')).toBe(false);
  });

  it('fail-open: an unreadable registry falls back to the unfiltered result (keeps a started sibling alive)', async () => {
    const reg = await import('../harness-registry');
    (reg.loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('registry down'));
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true');
    expect(await anyHivePlacementStarted(WS, 'forms')).toBe(true);
  });

  it('false when the just-stopped hive is the last one → idle the loop', async () => {
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    expect(await anyHivePlacementStarted(WS, 'forms')).toBe(false);
  });

  it('EXCLUDES the workspace sentinel row (installSlug === workspaceId) — it is a loop bit, not a hive', async () => {
    h.kv.set(`hive_started:${WS}:${WS}`, 'true'); // only the sentinel/loop bit
    expect(await anyHivePlacementStarted(WS)).toBe(false);
  });

  it('scopes to the workspace — a started hive in ANOTHER workspace does not keep this loop up', async () => {
    h.kv.set(`hive_started:other-ws:forms`, 'true');
    expect(await anyHivePlacementStarted(WS, 'anything')).toBe(false);
  });
});
