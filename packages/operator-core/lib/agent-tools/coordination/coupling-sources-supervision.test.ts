/**
 * coupling-sources-supervision.test.ts — P-007, the fleet supervision obligation.
 *
 * ⚠ THE SOURCE HERE IS NOT THE ONE THE PLAN ITEM NAMED, and that is deliberate (D-012).
 * P-007 specified `spawned_agents` (`parent_spawn_id` / `session_owner`). Measured before
 * implementing: all 9,040 rows across all 7 workspaces are terminal and **0 of 354 live
 * agents appear in it** — the nursery-cup tier it served is retired, so building on it
 * would have shipped a relation that never fires, exactly the D-088 / D-093 failure. The
 * live relationship is `coord_presence.fleet_slug` + `fleet_role` (275 live members under
 * 8 live leaders). Do not "restore" the original source.
 *
 * Two properties below carry most of the weight, and both are measured rather than
 * assumed:
 *   · MEMBER ↔ MEMBER EMITS NOTHING. D-002 rejected bare set membership as a coupling
 *     signal because nobody opts into it; a 292-member fleet would otherwise produce a
 *     quadratic wall of meaningless edges.
 *   · THE RESIDUE CUT IS LOAD-BEARING. 84 of 401 fleet-labelled rows in this workspace
 *     sit beyond the 2h horizon (83 members, 1 leader), so membership-label-alone would
 *     emit ~28% false obligations about agents that stopped existing hours ago.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  ownerId: string;
  fleetSlug: string;
  fleetRole: string | null;
  startedAt: Date;
  heartbeatAt: Date;
}

let rows = new Map<string, Row>();
let hasPgFastPath = true;
let livenessVerdicts = new Map<string, { ownerId: string; sessionState: string | null }>();

vi.mock('./log', () => ({
  coordHasPgFastPath: () => hasPgFastPath,
  coordWorkspaceId: () => 'papercusp-workspace',
  coordSql: () => () => Promise.resolve([]),
}));

vi.mock('./presence-fleet', () => ({
  fetchFleetSupervisionRows: (ownerIds: readonly string[]) => {
    const out = new Map<string, Row>();
    for (const id of new Set(ownerIds)) {
      const r = rows.get(id);
      if (r) out.set(id, r);
    }
    return Promise.resolve(out);
  },
}));

vi.mock('./liveness-oracle', () => ({
  resolveSessionStates: (subjects: readonly { ownerId: string }[]) => {
    const out = new Map<string, { ownerId: string; sessionState: string | null }>();
    for (const s of subjects) {
      const v = livenessVerdicts.get(s.ownerId);
      if (v) out.set(s.ownerId, v);
    }
    return Promise.resolve(out);
  },
}));

const { fetchFleetSupervision, SUPERVISION_MEMBERSHIP_HORIZON_MS } =
  await import('./coupling-sources');

const NOW = Date.parse('2026-08-25T07:00:00.000Z');
const FLEET = 'devboard-hive';
/** Comfortably inside the residue horizon. */
const FRESH = new Date(NOW - 60_000);
const STARTED = new Date(NOW - 3 * 60 * 60 * 1000);

const row = (ownerId: string, fleetRole: string | null, over: Partial<Row> = {}): Row => ({
  ownerId,
  fleetSlug: FLEET,
  fleetRole,
  startedAt: STARTED,
  heartbeatAt: FRESH,
  ...over,
});

const setRows = (...rs: Row[]) => {
  rows = new Map(rs.map((r) => [r.ownerId, r]));
  livenessVerdicts = new Map(
    rs.map((r) => [r.ownerId, { ownerId: r.ownerId, sessionState: 'live' as string | null }]),
  );
};

beforeEach(() => {
  rows = new Map();
  hasPgFastPath = true;
  livenessVerdicts = new Map();
});

describe('P-007 — supervision runs along the HIERARCHY, and only the hierarchy', () => {
  it('a LEADER owes supervision to each member (`i-owe`)', async () => {
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    const edges = await fetchFleetSupervision('su-lead', ['su-m1'], NOW);
    expect(edges).toEqual([
      {
        ownerId: 'su-m1',
        direction: 'i-owe',
        what: 'supervision of this fleet lane',
        since: STARTED.toISOString(),
        handle: FLEET,
        counterpartLiveness: 'live',
      },
    ]);
  });

  it('a MEMBER is owed supervision by the leader (`owes-me`) — the same pair, mirrored', async () => {
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    const edges = await fetchFleetSupervision('su-m1', ['su-lead'], NOW);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.direction).toBe('owes-me');
    expect(edges[0]?.ownerId).toBe('su-lead');
  });

  it('MEMBER ↔ MEMBER emits NOTHING — D-002 rejected bare set membership', async () => {
    // The load-bearing negative. Co-membership is not an obligation: nobody opted into
    // it, and emitting it would make a 292-member fleet quadratic.
    setRows(row('su-m1', 'member'), row('su-m2', 'member'), row('su-m3', 'member'));
    expect(await fetchFleetSupervision('su-m1', ['su-m2', 'su-m3'], NOW)).toEqual([]);
  });

  it('LEADER ↔ LEADER emits nothing', async () => {
    setRows(row('su-lead', 'leader'), row('su-lead2', 'leader'));
    expect(await fetchFleetSupervision('su-lead', ['su-lead2'], NOW)).toEqual([]);
  });

  it('an UNRECOGNISED role emits nothing rather than being coerced into one we know', async () => {
    setRows(row('su-lead', 'leader'), row('su-odd', 'observer'));
    expect(await fetchFleetSupervision('su-lead', ['su-odd'], NOW)).toEqual([]);
  });

  it('a leader that launches N peers sees exactly N supervision edges (the item’s VERIFY)', async () => {
    setRows(
      row('su-lead', 'leader'),
      row('su-m1', 'member'),
      row('su-m2', 'member'),
      row('su-m3', 'member'),
      row('su-m4', 'member'),
    );
    const edges = await fetchFleetSupervision('su-lead', ['su-m1', 'su-m2', 'su-m3', 'su-m4'], NOW);
    expect(edges).toHaveLength(4);
    // Distinguishable, which is the stated problem: "an agent supervising four launched
    // peers currently cannot distinguish any of them."
    expect(new Set(edges.map((e) => e.ownerId)).size).toBe(4);
    expect(edges.every((e) => e.direction === 'i-owe')).toBe(true);
  });
});

describe('P-007 — membership RESIDUE is discharged; a live-but-dead member is not', () => {
  it('drops a peer whose presence row is colder than the horizon', async () => {
    // 84 of 401 real fleet-labelled rows sit here. Without this cut a leader is chased
    // about dozens of agents that stopped existing hours ago.
    const cold = new Date(NOW - SUPERVISION_MEMBERSHIP_HORIZON_MS - 60_000);
    setRows(row('su-lead', 'leader'), row('su-gone', 'member', { heartbeatAt: cold }));
    expect(await fetchFleetSupervision('su-lead', ['su-gone'], NOW)).toEqual([]);
  });

  it('keeps a peer just INSIDE the horizon — the cut is a boundary, not a vibe', async () => {
    const justInside = new Date(NOW - SUPERVISION_MEMBERSHIP_HORIZON_MS + 60_000);
    setRows(row('su-lead', 'leader'), row('su-m1', 'member', { heartbeatAt: justInside }));
    expect(await fetchFleetSupervision('su-lead', ['su-m1'], NOW)).toHaveLength(1);
  });

  it('STILL emits for a DEAD member, carrying `ended` — the most actionable case', async () => {
    // A member that died while its lane was open is precisely what a leader must see, so
    // liveness carries the verdict rather than the edge being suppressed.
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    livenessVerdicts.set('su-m1', { ownerId: 'su-m1', sessionState: 'ended' });
    const edges = await fetchFleetSupervision('su-lead', ['su-m1'], NOW);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.counterpartLiveness).toBe('ended');
  });

  it('reports `unknown` for a member the oracle cannot measure, never `live`', async () => {
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    livenessVerdicts.delete('su-m1');
    const edges = await fetchFleetSupervision('su-lead', ['su-m1'], NOW);
    expect(edges[0]?.counterpartLiveness).toBe('unknown');
  });

  it('emits nothing when the CALLER’s own row is residue', async () => {
    const cold = new Date(NOW - SUPERVISION_MEMBERSHIP_HORIZON_MS - 60_000);
    setRows(row('su-lead', 'leader', { heartbeatAt: cold }), row('su-m1', 'member'));
    expect(await fetchFleetSupervision('su-lead', ['su-m1'], NOW)).toEqual([]);
  });
});

describe('P-007 — scope and fail-soft', () => {
  it('never crosses fleets', async () => {
    setRows(
      row('su-lead', 'leader'),
      row('su-other', 'member', { fleetSlug: 'a-different-fleet' }),
    );
    expect(await fetchFleetSupervision('su-lead', ['su-other'], NOW)).toEqual([]);
  });

  it('emits nothing when the caller is in no fleet at all', async () => {
    setRows(row('su-m1', 'member'));
    // Caller absent from the map entirely ⇒ no fleet row ⇒ no claim of supervision.
    expect(await fetchFleetSupervision('su-nofleet', ['su-m1'], NOW)).toEqual([]);
  });

  it('uses the fleet slug as the handle — what a reader can act on', async () => {
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    const edges = await fetchFleetSupervision('su-lead', ['su-m1'], NOW);
    // `fleet:assignments { fleet }` takes exactly this.
    expect(edges[0]?.handle).toBe(FLEET);
  });

  it('returns [] with no PG fast path, without consulting the store', async () => {
    hasPgFastPath = false;
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    expect(await fetchFleetSupervision('su-lead', ['su-m1'], NOW)).toEqual([]);
  });

  it('returns [] for a blank caller id', async () => {
    setRows(row('su-lead', 'leader'), row('su-m1', 'member'));
    expect(await fetchFleetSupervision('   ', ['su-m1'], NOW)).toEqual([]);
  });
});
