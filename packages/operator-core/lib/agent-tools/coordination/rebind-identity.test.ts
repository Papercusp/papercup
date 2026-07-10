/**
 * rebind-identity — unit tests (compaction-continuity-hardening-2026-07-07 P-007).
 * The core is a per-surface, idempotent from→to migration over injected sql.
 * Load-bearing contracts: the from-appears-live presence guard (never steal a
 * live peer's identity), collision semantics (the LIVE id's row / the NEWER
 * carry-note wins; a duplicate active await is cancelled, not doubled), the
 * append-only fleet fact discipline, and per-surface error isolation.
 */
import { describe, expect, it } from 'vitest';
import { rebindIdentity, REBIND_FROM_LIVE_WINDOW_MS } from './rebind-identity';
import { loopRoutineId, loopRoutineName } from '../../harness/routines/loop';

const NOW = 1_800_000_000_000;
const FROM = 'su-old-aaaa';
const TO = 'su-new-bbbb';

interface FakeCall {
  text: string;
  vals: unknown[];
}

interface FakeOpts {
  /** Age of the from-id's presence beat; null/undefined = no presence row. */
  presenceBeatMsAgo?: number | null;
  loops?: Array<{ id: string; install_slug: string }>;
  /** New loop ids that already exist (the live id armed its own loop). */
  loopIdExists?: string[];
  notes?: Array<{ workspace_id: string; scope: string; updated_ts: string }>;
  /** target-scope → updated_ts for pre-existing to-side notes. */
  noteClash?: Record<string, string>;
  presenceDrop?: number;
  fleetLatest?: { workspace_id: string; owner_label: string | null; fleet_slug: string | null; fleet_role: string | null } | null;
  fleetToLatest?: { fleet_slug: string | null } | null;
  leaderSlugs?: string[];
  claimSpecDrop?: number;
  claimSpecMove?: number;
  awaits?: Array<{ id: number; workspace_id: string; event_key: string }>;
  /** Rewritten event keys that already have an identical active to-await. */
  awaitDupKeys?: string[];
  planClaims?: number;
  workClaims?: number;
  wmDrop?: number;
  wmMove?: number;
  heldItems?: number;
  heldWorkItems?: number;
  factsDrop?: number;
  factsMove?: number;
  pendingWakes?: number;
  /** Statements matching this throw (per-surface error isolation). */
  failOn?: RegExp;
}

const rows = (n: number | undefined, shape: Record<string, unknown> = { x: 1 }) =>
  Array.from({ length: n ?? 0 }, () => ({ ...shape }));

function fakeSql(opts: FakeOpts = {}) {
  const calls: FakeCall[] = [];
  const fn = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.raw.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ text, vals });
    if (opts.failOn?.test(text)) return Promise.reject(new Error('surface exploded'));
    if (text.includes('SELECT heartbeat_at FROM harness_shared.coord_presence')) {
      return Promise.resolve(
        opts.presenceBeatMsAgo == null
          ? []
          : [{ heartbeat_at: new Date(NOW - opts.presenceBeatMsAgo).toISOString() }],
      );
    }
    if (text.includes('SELECT id, install_slug FROM harness_shared.routines')) return Promise.resolve(opts.loops ?? []);
    if (text.includes('SELECT id FROM harness_shared.routines WHERE id =')) {
      return Promise.resolve((opts.loopIdExists ?? []).includes(String(vals[0])) ? [{ id: vals[0] }] : []);
    }
    if (text.includes('SELECT workspace_id, scope, updated_ts FROM harness_shared.carry_notes')) {
      return Promise.resolve(opts.notes ?? []);
    }
    if (text.includes('SELECT updated_ts FROM harness_shared.carry_notes')) {
      const ts = opts.noteClash?.[String(vals[1])];
      return Promise.resolve(ts ? [{ updated_ts: ts }] : []);
    }
    if (text.includes('DELETE FROM harness_shared.coord_presence')) {
      return Promise.resolve(rows(opts.presenceDrop, { owner_id: FROM }));
    }
    if (text.includes('SELECT workspace_id, owner_label, fleet_slug, fleet_role FROM harness_shared.fleet_membership_events')) {
      return Promise.resolve(opts.fleetLatest ? [opts.fleetLatest] : []);
    }
    if (text.includes('SELECT fleet_slug FROM harness_shared.fleet_membership_events')) {
      return Promise.resolve(opts.fleetToLatest ? [opts.fleetToLatest] : []);
    }
    if (text.includes('UPDATE harness_shared.agent_fleets')) {
      return Promise.resolve((opts.leaderSlugs ?? []).map((slug) => ({ slug })));
    }
    if (text.includes('DELETE FROM harness_shared.bee_claim_specs')) {
      return Promise.resolve(rows(opts.claimSpecDrop, { bee_id: FROM }));
    }
    if (text.includes('UPDATE harness_shared.bee_claim_specs')) {
      return Promise.resolve(rows(opts.claimSpecMove, { bee_id: TO }));
    }
    if (text.includes('SELECT id, workspace_id, event_key FROM harness_shared.event_awaits')) {
      return Promise.resolve(opts.awaits ?? []);
    }
    if (text.includes('SELECT id FROM harness_shared.event_awaits')) {
      return Promise.resolve((opts.awaitDupKeys ?? []).includes(String(vals[2])) ? [{ id: 999 }] : []);
    }
    if (text.includes('UPDATE harness_shared.plan_item_claims')) {
      return Promise.resolve(rows(opts.planClaims, { owner: TO }));
    }
    if (text.includes('UPDATE harness_shared.work_item_claims')) {
      return Promise.resolve(rows(opts.workClaims, { owner: TO }));
    }
    if (text.includes('DELETE FROM harness_shared.coord_watermarks')) {
      return Promise.resolve(rows(opts.wmDrop, { owner_id: FROM }));
    }
    if (text.includes('UPDATE harness_shared.coord_watermarks')) {
      return Promise.resolve(rows(opts.wmMove, { owner_id: TO }));
    }
    if (text.includes('UPDATE harness_shared.engineer_issues')) {
      return Promise.resolve(rows(opts.heldItems, { issue_id: 'WI-1' }));
    }
    if (text.includes('UPDATE harness_shared.work_items')) {
      return Promise.resolve(rows(opts.heldWorkItems, { feature_id: 'WI-2' }));
    }
    if (text.includes('DELETE FROM harness_shared.agent_facts')) {
      return Promise.resolve(rows(opts.factsDrop, { key: 'k' }));
    }
    if (text.includes('UPDATE harness_shared.agent_facts')) {
      return Promise.resolve(rows(opts.factsMove, { key: 'k' }));
    }
    if (text.includes('UPDATE harness_shared.pending_wakes')) {
      return Promise.resolve(rows(opts.pendingWakes, { id: 42 }));
    }
    // Remaining writes (routine/carry-note/await/fleet-event mutations) return no rows.
    return Promise.resolve([]);
  };
  return Object.assign(fn, { calls });
}

const surfaceOf = (res: Awaited<ReturnType<typeof rebindIdentity>>, name: string) => {
  const s = res.surfaces.find((x) => x.surface === name);
  expect(s, `surface ${name} missing`).toBeTruthy();
  return s!;
};

describe('argument + liveness guards', () => {
  it('refuses identical / blank identities without touching the DB', async () => {
    const sql = fakeSql();
    for (const [f, t] of [
      [FROM, FROM],
      ['', TO],
      [FROM, '  '],
    ] as const) {
      const res = await rebindIdentity(f, t, { sql: sql as never, now: NOW });
      expect(res).toMatchObject({ ok: false, refused: 'bad_args' });
    }
    expect(sql.calls).toHaveLength(0);
  });

  it('refuses while the from-id still beats within the live window (never steal a live peer)', async () => {
    const sql = fakeSql({ presenceBeatMsAgo: 30_000 });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(res).toMatchObject({ ok: false, refused: 'from_appears_live' });
    expect(res.fromHeartbeatAgoMs).toBe(30_000);
    expect(res.surfaces).toHaveLength(0);
    // Only the guard read ran.
    expect(sql.calls).toHaveLength(1);
  });

  it('proceeds when the beat is stale, when no presence row exists, and under force despite a fresh beat', async () => {
    for (const opts of [
      { presenceBeatMsAgo: REBIND_FROM_LIVE_WINDOW_MS + 1, force: undefined },
      { presenceBeatMsAgo: null, force: undefined },
      { presenceBeatMsAgo: 5_000, force: true },
    ]) {
      const sql = fakeSql({ presenceBeatMsAgo: opts.presenceBeatMsAgo });
      const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW, force: opts.force });
      expect(res.ok).toBe(true);
      expect(res.surfaces).toHaveLength(14);
    }
  });

  it('a throwing guard read fails OPEN — the caller chose to rebind and the moves are idempotent', async () => {
    const sql = fakeSql({ failOn: /SELECT heartbeat_at/ });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.surfaces).toHaveLength(14);
  });
});

describe('armed loop routine', () => {
  it('re-keys id + name + target_owner_id and text-replaces the sid inside payload_template', async () => {
    const oldId = loopRoutineId('papercusp', FROM);
    const sql = fakeSql({ loops: [{ id: oldId, install_slug: 'papercusp' }] });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'loop-routine')).toMatchObject({ moved: 1 });
    const update = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.routines'));
    expect(update).toBeTruthy();
    expect(update!.vals).toContain(loopRoutineId('papercusp', TO));
    expect(update!.vals).toContain(loopRoutineName(TO));
    expect(update!.text).toContain('replace(payload_template::text');
  });

  it('drops the ghost loop when the live id already armed its own', async () => {
    const oldId = loopRoutineId('papercusp', FROM);
    const sql = fakeSql({
      loops: [{ id: oldId, install_slug: 'papercusp' }],
      loopIdExists: [loopRoutineId('papercusp', TO)],
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'loop-routine')).toMatchObject({ moved: 0, dropped: 1 });
    const del = sql.calls.find((c) => c.text.includes('DELETE FROM harness_shared.routines'));
    expect(del!.vals).toContain(oldId);
  });
});

describe('loop carry-note (+walls) scope rows', () => {
  const note = (scope: string, ts = '2026-07-07T10:00:00Z') => ({ workspace_id: 'coord-ws', scope, updated_ts: ts });

  it('moves both the loop and loopnag scopes to the live id', async () => {
    const sql = fakeSql({ notes: [note(`loop:papercusp:${FROM}`), note(`loopnag:papercusp:${FROM}`)] });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'carry-note')).toMatchObject({ moved: 2 });
    const updates = sql.calls.filter((c) => c.text.includes('UPDATE harness_shared.carry_notes'));
    expect(updates.map((u) => u.vals[0])).toEqual([`loop:papercusp:${TO}`, `loopnag:papercusp:${TO}`]);
  });

  it('a FRESHER to-side note wins: the ghost from-row is dropped, never clobbers', async () => {
    const sql = fakeSql({
      notes: [note(`loop:papercusp:${FROM}`, '2026-07-07T10:00:00Z')],
      noteClash: { [`loop:papercusp:${TO}`]: '2026-07-07T11:00:00Z' },
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'carry-note')).toMatchObject({ moved: 0, dropped: 1 });
    expect(sql.calls.some((c) => c.text.includes('UPDATE harness_shared.carry_notes'))).toBe(false);
  });

  it('a STALER to-side note is replaced by the from-note (walls carry-forward truth)', async () => {
    const sql = fakeSql({
      notes: [note(`loop:papercusp:${FROM}`, '2026-07-07T12:00:00Z')],
      noteClash: { [`loop:papercusp:${TO}`]: '2026-07-07T11:00:00Z' },
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'carry-note')).toMatchObject({ moved: 1 });
    const del = sql.calls.find((c) => c.text.includes('DELETE FROM harness_shared.carry_notes'));
    expect(del!.vals).toContain(`loop:papercusp:${TO}`);
  });
});

describe('standing awaits', () => {
  it('rewrites subscriber + sid-embedding event keys; cancels instead of duplicating an active to-await', async () => {
    const sql = fakeSql({
      awaits: [
        { id: 1, workspace_id: 'coord-ws', event_key: `coord:inbox-wake:${FROM}` },
        { id: 2, workspace_id: 'coord-ws', event_key: 'work-item:done:WI-9' },
      ],
      awaitDupKeys: [`coord:inbox-wake:${TO}`],
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'awaits')).toMatchObject({ moved: 1, cancelled: 1 });
    const cancel = sql.calls.find((c) => c.text.includes('SET cancelled_at'));
    expect(cancel!.vals).toContain(1);
    const move = sql.calls.find((c) => c.text.includes('SET subscriber_id'));
    expect(move!.vals).toEqual([TO, 'work-item:done:WI-9', 2]);
  });
});

describe('fleet membership (append-only) + leadership', () => {
  it('closes the old membership with a leave-fact and re-opens the fleet+role under the live id', async () => {
    const sql = fakeSql({
      fleetLatest: { workspace_id: 'coord-ws', owner_label: 'su · su-old', fleet_slug: 'bug-drain', fleet_role: 'leader' },
      fleetToLatest: null,
      leaderSlugs: ['bug-drain'],
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'fleet-membership')).toMatchObject({ appended: 2 });
    expect(surfaceOf(res, 'fleet-leadership')).toMatchObject({ moved: 1 });
    const inserts = sql.calls.filter((c) => c.text.includes('INSERT INTO harness_shared.fleet_membership_events'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].vals).toContain(TO);
    expect(inserts[0].vals).toContain('lead'); // leader role re-opens as a lead-fact
    expect(inserts[1].vals).toContain(FROM);
    expect(inserts[1].text).toContain("'leave'"); // the leave-fact is a literal in the statement
  });

  it('skips the join-fact when the live id already sits in that fleet; no facts at all when the old id had none', async () => {
    const inFleet = fakeSql({
      fleetLatest: { workspace_id: 'coord-ws', owner_label: null, fleet_slug: 'bug-drain', fleet_role: 'member' },
      fleetToLatest: { fleet_slug: 'bug-drain' },
    });
    const res1 = await rebindIdentity(FROM, TO, { sql: inFleet as never, now: NOW });
    expect(surfaceOf(res1, 'fleet-membership')).toMatchObject({ appended: 1 }); // just the leave
    const noFleet = fakeSql({ fleetLatest: { workspace_id: 'coord-ws', owner_label: null, fleet_slug: null, fleet_role: null } });
    const res2 = await rebindIdentity(FROM, TO, { sql: noFleet as never, now: NOW });
    expect(surfaceOf(res2, 'fleet-membership').appended).toBeUndefined();
  });
});

describe('remaining re-keys, totals, and error isolation', () => {
  it('claims / claim-spec / watermarks / held items / owner facts move with live-side-wins drops', async () => {
    const sql = fakeSql({
      presenceDrop: 1,
      claimSpecDrop: 1,
      claimSpecMove: 0,
      planClaims: 2,
      workClaims: 3,
      wmDrop: 1,
      wmMove: 1,
      heldItems: 4,
      heldWorkItems: 5,
      factsDrop: 1,
      factsMove: 2,
      pendingWakes: 3,
    });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'presence')).toMatchObject({ dropped: 1 });
    expect(surfaceOf(res, 'claim-spec')).toMatchObject({ moved: 0, dropped: 1 });
    expect(surfaceOf(res, 'plan-claims')).toMatchObject({ moved: 2 });
    expect(surfaceOf(res, 'work-claims')).toMatchObject({ moved: 3 });
    expect(surfaceOf(res, 'watermarks')).toMatchObject({ moved: 1, dropped: 1 });
    expect(surfaceOf(res, 'held-items')).toMatchObject({ moved: 4 });
    expect(surfaceOf(res, 'held-work-items')).toMatchObject({ moved: 5 });
    expect(surfaceOf(res, 'owner-facts')).toMatchObject({ moved: 2, dropped: 1 });
    expect(surfaceOf(res, 'pending-wakes')).toMatchObject({ moved: 3 });
    expect(res.totalMoved).toBe(24);
    expect(res.ok).toBe(true);
  });

  it('pending-wakes (EI-8999) re-keys staged manual-mode wakes so a compaction rebind never strands one under the dead sid', async () => {
    const sql = fakeSql({ pendingWakes: 2 });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'pending-wakes')).toMatchObject({ moved: 2 });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.pending_wakes SET owner_id'));
    expect(upd).toBeTruthy();
    expect(upd!.vals).toEqual([TO, FROM]);
  });

  it('held-items re-key excludes terminal states (history keeps its author)', async () => {
    const sql = fakeSql({ heldItems: 1 });
    await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.engineer_issues'));
    expect(upd!.text).toContain("state NOT IN ('done', 'resolved', 'deprecated', 'closed')");
  });

  it('held-work-items (WI-3642) re-keys work_items.taken_by directly, covering EVERY item_kind, excluding terminal statuses', async () => {
    const sql = fakeSql({ heldWorkItems: 2 });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(surfaceOf(res, 'held-work-items')).toMatchObject({ moved: 2 });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.work_items SET taken_by'));
    expect(upd).toBeTruthy();
    // No item_kind filter — unlike the engineer_issues view (step 11), this covers
    // feature/research-task/chunk too, not just bug/change/task.
    expect(upd!.text).not.toContain('item_kind');
    expect(upd!.text).toContain('status <> ALL(?::text[])');
    expect(upd!.vals).toContain(TO);
    expect(upd!.vals).toContain(FROM);
  });

  it('one exploding surface reports its error and never sinks the others (idempotent re-run finishes it)', async () => {
    const sql = fakeSql({ planClaims: 1, failOn: /UPDATE harness_shared\.agent_fleets/ });
    const res = await rebindIdentity(FROM, TO, { sql: sql as never, now: NOW });
    expect(res.ok).toBe(false);
    expect(surfaceOf(res, 'fleet-leadership').error).toContain('surface exploded');
    expect(res.surfaces).toHaveLength(14);
    expect(surfaceOf(res, 'plan-claims')).toMatchObject({ moved: 1 });
  });
});
