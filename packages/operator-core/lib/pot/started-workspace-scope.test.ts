/**
 * started-workspace-scope.test.ts — P-003 (workspace-scoped-coordination-2026-06-20,
 * D-006/D-007): the K1 workspace-papercup re-key of the Start/Pause-Pot state +
 * the de-duped Mug-liveness loop set, gated on FLAGS.WORKSPACE_COORDINATION.
 *
 *   - getPotStarted / setPotStarted: ON ⇒ the started bit collapses to ONE row
 *     per workspace under the papercup (key install dimension = workspaceId), with
 *     a READ-FALLBACK to the legacy per-pot row; OFF ⇒ the per-(ws,install) row,
 *     BYTE-IDENTICAL to today.
 *   - listStartedWorkspaceLoops: ON ⇒ ONE entry per started workspace (the
 *     liveness loop the watchdog/throughput sweep runs once); OFF ⇒ the raw
 *     per-pot set, byte-identical to listStartedPots.
 *
 * Hermetic: the PG/flag edges are mocked, so this pins the KEYING DECISION (not
 * the DB) — the Mug-side companion to scheduler-workspace-scope.ts's Scout
 * coverage. The pure papercup math itself is covered in
 * ../workspace-brain-scope.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  isWorkspaceCoordinationOn: vi.fn(async () => false),
  backgroundWorkspaceIds: vi.fn(() => ['papercusp-workspace']),
  // The fake operator_settings KV: key → 'true' | 'false'.
  kv: new Map<string, string>(),
  upserts: [] as Array<{ key: string; value: string }>,
  // WI-3193: the set of CURRENTLY-REGISTERED kind:'hive' slugs the fake harness
  // registry reports. anyPotPlacementStarted now intersects the started rows with
  // this, so a stale started-row for an UNREGISTERED slug can't pin the loop alive.
  registeredPots: [] as string[],
  registeredProjects: [] as Array<{ slug: string; harness_kind?: string; ephemeral_foreign?: boolean }>,
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
    // listStartedPots scan: SELECT key ... WHERE key LIKE 'hive_started:%' AND value='true'
    const out = [...h.kv.entries()]
      .filter(([k, v]) => k.startsWith('hive_started:') && v === 'true')
      .map(([k]) => ({ key: k }));
    return Promise.resolve(out);
  }
  return Promise.resolve([]);
};

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: fakeSql }) }));
vi.mock('../workspace-registry', async (importActual) => {
  const actual = await importActual<typeof import('../workspace-registry')>();
  return { ...actual, backgroundWorkspaceIds: h.backgroundWorkspaceIds };
});
// P-007 (retire-mug-kettle-su-only-2026-08-09): getPotStarted now short-circuits
// to false while the mug/kettle tier is RETIRED (the flag's default). Every case
// in this file is about K1 papercup-vs-legacy row SCOPING, which only exists to
// be exercised while the tier is live — so pin the tier ON here. Without this
// the whole file goes green-to-red in the least informative way: getPotStarted
// returns false before it reads any row, so the scoping assertions fail with
// "expected false to be true" and say nothing about scoping at all.
// Key-aware rather than a blanket `true`: this file's only other flag read
// (isWorkspaceCoordinationOn) is mocked separately just below, and a blanket
// true would silently switch that behaviour too if it were ever un-mocked.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: async (key: string) => key === 'papercusp-mug-kettle-system',
}));
// Keep the REAL pure papercup math; only stub the flag read.
vi.mock('../workspace-brain-scope', async (importActual) => {
  const actual = await importActual<typeof import('../workspace-brain-scope')>();
  return { ...actual, isWorkspaceCoordinationOn: h.isWorkspaceCoordinationOn };
});
// WI-3193: fake harness registry so anyPotPlacementStarted's registered-pot
// intersection is deterministic — reports each slug in h.registeredPots as a
// kind:'hive' project (the only field the intersection reads).
vi.mock('../harness-registry', () => ({
  loadHarnessRegistry: vi.fn(async () => ({
    projects: h.registeredProjects,
  })),
  isEphemeralForeignProject: (p: { ephemeral_foreign?: boolean }) => p.ephemeral_foreign === true,
}));

import {
  getPotStarted,
  setPotStarted,
  getPotPlacementStarted,
  setPotPlacementStarted,
  anyPotPlacementStarted,
  listStartedPots,
  listBlenderMaintenanceScopes,
  listStartedWorkspaceLoops,
} from './started';

const WS = 'papercusp-workspace';
const POT = 'papercusp';

beforeEach(() => {
  h.kv.clear();
  h.upserts.length = 0;
  h.registeredPots = ['papercusp', 'pot-a', 'pot-b', 'pot-x', 'other-ws'];
  h.registeredProjects = h.registeredPots.map((slug) => ({ slug, harness_kind: 'hive' }));
  h.backgroundWorkspaceIds.mockReset().mockReturnValue([WS]);
  h.isWorkspaceCoordinationOn.mockReset().mockResolvedValue(false);
  delete process.env.PAPERCUSP_POT_HOME_SLUG;
});

describe('setPotStarted — K1 workspace-papercup write key (P-003)', () => {
  it('flag OFF → writes the legacy per-(ws,install) row (byte-identical to today)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    await setPotStarted(WS, POT, true);
    // WI-3261: every setPotStarted call also writes the pause-provenance bit
    // (started:true always clears `deliberate`, regardless of caller).
    expect(h.upserts).toEqual([
      { key: `hive_started:${WS}:${POT}`, value: 'true' },
      { key: `hive_paused_deliberate:${WS}:${POT}`, value: 'false' },
    ]);
  });

  it('flag ON → writes the workspace-papercup row (install dimension = workspaceId)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    await setPotStarted(WS, POT, true);
    // WI-3261: pause-provenance bit is scoped identically (workspace papercup).
    expect(h.upserts).toEqual([
      { key: `hive_started:${WS}:${WS}`, value: 'true' },
      { key: `hive_paused_deliberate:${WS}:${WS}`, value: 'false' },
    ]);
  });
});

/**
 * getPotStarted — K1 read-fallback (P-003): RETIRED WITH THE TIER, not deleted.
 *
 * This block used to assert the four K1 read-fallback behaviours listed below.
 * They are UNREACHABLE as of the mug/kettle retirement
 * (retire-mug-kettle-su-only-2026-08-09 P-007, D-004/D-008), because getPotStarted
 * now opens with a hard engine gate — started.ts:121:
 *
 *     if (!(await mugKettleSystemEnabled())) return false;
 *
 * and mugKettleSystemEnabled (started.ts:59-61) is hard-wired `return false`. It no
 * longer consults a flag at all, so THIS FILE'S `getFlag` MOCK CANNOT REACH IT —
 * which is precisely how these four went red and stayed red: the mock still looks
 * like it enables the tier, and has had no effect since the hard-wiring landed.
 *
 * The WRITE-side K1 tests above still pass and are still live, because
 * setPotStarted carries no such gate — that asymmetry is the tell.
 *
 * The retired contract is covered authoritatively (with a calibration test and a
 * short-circuit proof) by ./mug-kettle-engine-gate.test.ts, so re-asserting it here
 * would be duplication. Only the tripwire below is kept.
 *
 * WHEN THE TIER IS UN-RETIRED, restore these four assertions verbatim — they are
 * the K1 semantics and nothing else records them:
 *   1. flag OFF  → reads ONLY `hive_started:<ws>:<pot>`; a `<ws>:<ws>` papercup row
 *                  must be IGNORED (no widening).
 *   2. flag ON   → PREFERS the papercup row `hive_started:<ws>:<ws>`.
 *   3. flag ON, no papercup row yet → FALLS BACK to the legacy per-pot row.
 *   4. flag ON   → the papercup bit resolves for ANY pot in the workspace
 *                  (central-dispatch widening).
 */
describe('getPotStarted — engine gate (tier retired)', () => {
  it('TRIPWIRE: resolves false even with a started row, in BOTH coordination modes', async () => {
    // Deliberately set the row that would have made the K1 read return true. If
    // this ever goes green-by-returning-true, the engine gate has been removed and
    // the four K1 assertions in the comment above must come back with it.
    h.kv.set(`hive_started:${WS}:${POT}`, 'true');
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    expect(await getPotStarted(WS, POT)).toBe(false);
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    expect(await getPotStarted(WS, POT)).toBe(false);
  });
});

describe('listStartedPots — raw per-pot set (placement gate, UNCHANGED)', () => {
  it('flag OFF or ON → the raw rows (byte-identical; the per-pot placement gate keeps real slugs)', async () => {
    h.kv.set(`hive_started:${WS}:pot-a`, 'true');
    h.kv.set(`hive_started:${WS}:pot-b`, 'true');
    h.kv.set(`hive_started:${WS}:pot-c`, 'false'); // not started
    h.isWorkspaceCoordinationOn.mockResolvedValue(true); // listStartedPots never collapses
    const rows = await listStartedPots();
    expect(rows).toEqual([
      { workspaceId: WS, installSlug: 'pot-a' },
      { workspaceId: WS, installSlug: 'pot-b' },
    ]);
  });
});

describe('listBlenderMaintenanceScopes — retained Blender population', () => {
  it('enumerates registered Hive scopes even when every retired started bit is false', async () => {
    expect(await listBlenderMaintenanceScopes()).toEqual(
      h.registeredPots.map((installSlug) => ({ workspaceId: WS, installSlug })),
    );
  });

  it('keeps workspace tags and excludes non-Hive and ephemeral registry entries', async () => {
    h.backgroundWorkspaceIds.mockReturnValue([WS, 'other-ws']);
    h.registeredProjects = [
      { slug: 'same-slug', harness_kind: 'hive' },
      { slug: 'member-repo', harness_kind: 'coding' },
      { slug: 'foreign', harness_kind: 'hive', ephemeral_foreign: true },
    ];

    expect(await listBlenderMaintenanceScopes()).toEqual([
      { workspaceId: WS, installSlug: 'same-slug' },
      { workspaceId: 'other-ws', installSlug: 'same-slug' },
    ]);
  });
});

describe('listStartedWorkspaceLoops — de-duped Mug-liveness loop (P-003)', () => {
  it('flag OFF → the raw per-pot set (byte-identical to listStartedPots)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(false);
    h.kv.set(`hive_started:${WS}:pot-a`, 'true');
    h.kv.set(`hive_started:${WS}:pot-b`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([
      { workspaceId: WS, installSlug: 'pot-a' },
      { workspaceId: WS, installSlug: 'pot-b' },
    ]);
  });

  it('flag ON → ONE loop per workspace, seated at the env home pot', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = POT;
    // Two hives started in the same workspace (papercup + a stray legacy row).
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.kv.set(`hive_started:${WS}:pot-b`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([{ workspaceId: WS, installSlug: POT }]);
  });

  it('flag ON, no env home → seats at the first row\'s install (multi-home pre-flip stays sane)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:pot-x`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([{ workspaceId: WS, installSlug: 'pot-x' }]);
  });

  it('flag ON → distinct workspaces each get exactly one loop', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = POT;
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.kv.set(`hive_started:other-ws:other-ws`, 'true');
    const loops = await listStartedWorkspaceLoops();
    expect(loops).toHaveLength(2);
    expect(loops.map((l) => l.workspaceId).sort()).toEqual(['other-ws', WS].sort());
  });

  it('flag ON → validates the env seat and falls back to a registered started pot', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    process.env.PAPERCUSP_POT_HOME_SLUG = 'deleted-home';
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    h.kv.set(`hive_started:${WS}:pot-b`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([{ workspaceId: WS, installSlug: 'pot-b' }]);
  });

  it('flag ON → omits a workspace with only an unregistered papercup row', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.registeredPots = [];
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    expect(await listStartedWorkspaceLoops()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-pot placement bit — the HONEST per-pot Start/Stop read/write (WI-1324,
// per-pot start-stop 2026-06-30). The bug: getPotStarted is papercup-first, so
// under WORKSPACE_COORDINATION every registered pot read the SAME workspace
// papercup → the pill showed "N hives running" though all were dormant, and
// pot:pause wrote the shared papercup (harness discarded) so "Stop pot X"
// stopped the whole workspace. getPotPlacementStarted / setPotPlacementStarted
// are the RAW per-(ws,install) row: they IGNORE the papercup collapse entirely
// (no flag read), so each pot reports its own honest state and pot.controlState
// (which now reads getPotPlacementStarted) drives one honest control per pot.
// ---------------------------------------------------------------------------
describe('getPotPlacementStarted / setPotPlacementStarted — raw per-pot bit (WI-1324)', () => {
  it('reads the RAW per-pot row, IGNORING the workspace papercup (kills the phantom "N running")', async () => {
    // Even with the collapse flag ON and the workspace papercup started (the Mug
    // LOOP is running)...
    h.isWorkspaceCoordinationOn.mockResolvedValue(true);
    h.kv.set(`hive_started:${WS}:${WS}`, 'true');
    // ...a pot with NO per-pot placement bit is NOT placed → reads false.
    expect(await getPotPlacementStarted(WS, 'forms')).toBe(false);
    expect(await getPotPlacementStarted(WS, 'sheets')).toBe(false);
  });

  it('writes the per-(ws,install) row REGARDLESS of the flag (harness never discarded)', async () => {
    h.isWorkspaceCoordinationOn.mockResolvedValue(true); // even with the collapse flag ON...
    await setPotPlacementStarted(WS, 'forms', true);
    // ...the write targets the REAL pot slug, not the papercup row. The
    // provenance write-through (WI-3309: cleared on a start) is keyed by the
    // REAL pot slug too — the collapse never applies to placement rows.
    expect(h.upserts).toEqual([
      { key: `hive_started:${WS}:forms`, value: 'true' },
      { key: `hive_paused_deliberate:${WS}:forms`, value: 'false' },
    ]);
    expect(await getPotPlacementStarted(WS, 'forms')).toBe(true);
    expect(await getPotPlacementStarted(WS, 'sheets')).toBe(false); // a sibling stays untouched
  });

  it('"Stop pot X" flips ONLY X (round-trip): start two, stop one → the other stays started', async () => {
    await setPotPlacementStarted(WS, 'forms', true);
    await setPotPlacementStarted(WS, 'sheets', true);
    await setPotPlacementStarted(WS, 'forms', false); // "Stop pot forms"
    expect(await getPotPlacementStarted(WS, 'forms')).toBe(false);
    expect(await getPotPlacementStarted(WS, 'sheets')).toBe(true);
  });

  it('default false when the pot was never started per-pot', async () => {
    expect(await getPotPlacementStarted(WS, 'never-started')).toBe(false);
  });
});

describe('anyPotPlacementStarted — the papercup-idle gate for pot:pause (WI-1324)', () => {
  // pot:pause idles the workspace Mug LOOP (papercup off) ONLY when NO OTHER
  // pot remains started (excludeSlug = the just-stopped pot), so the single loop
  // keeps running for the other started hives.
  it('true when another REGISTERED pot remains started → keep the workspace loop running', async () => {
    h.registeredPots = ['forms', 'sheets'];
    h.registeredProjects = h.registeredPots.map((slug) => ({ slug, harness_kind: 'hive' }));
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true');
    // Stopping `forms` — `sheets` is still started AND registered.
    expect(await anyPotPlacementStarted(WS, 'forms')).toBe(true);
  });

  // WI-3193 recurrence guard (owner-reported "I clicked Stop and it kept running"):
  // a stale started-row for a pot NO LONGER in the registry must NOT keep the loop
  // alive, else pot:pause can never idle the workspace Mug (papercup stays true →
  // watchdog re-arms the wake ~30s later; the declare_wake paused-gate never trips).
  it('false when the only other started row is a STALE UNREGISTERED slug → idle the loop', async () => {
    h.registeredPots = ['forms']; // `sheets` was dissolved/never-registered
    h.registeredProjects = h.registeredPots.map((slug) => ({ slug, harness_kind: 'hive' }));
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true'); // stale leftover row
    // Stopping `forms` — `sheets` is started in the KV but is NOT a registered pot.
    expect(await anyPotPlacementStarted(WS, 'forms')).toBe(false);
  });

  it('fail-open: an unreadable registry falls back to the unfiltered result (keeps a started sibling alive)', async () => {
    const reg = await import('../harness-registry');
    (reg.loadHarnessRegistry as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('registry down'));
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    h.kv.set(`hive_started:${WS}:sheets`, 'true');
    expect(await anyPotPlacementStarted(WS, 'forms')).toBe(true);
  });

  it('false when the just-stopped pot is the last one → idle the loop', async () => {
    h.kv.set(`hive_started:${WS}:forms`, 'true');
    expect(await anyPotPlacementStarted(WS, 'forms')).toBe(false);
  });

  it('EXCLUDES the workspace papercup row (installSlug === workspaceId) — it is a loop bit, not a pot', async () => {
    h.kv.set(`hive_started:${WS}:${WS}`, 'true'); // only the papercup/loop bit
    expect(await anyPotPlacementStarted(WS)).toBe(false);
  });

  it('scopes to the workspace — a started pot in ANOTHER workspace does not keep this loop up', async () => {
    h.kv.set(`hive_started:other-ws:forms`, 'true');
    expect(await anyPotPlacementStarted(WS, 'anything')).toBe(false);
  });
});
