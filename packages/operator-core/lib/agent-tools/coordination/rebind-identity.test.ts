/**
 * rebind-identity — unit tests (compaction-continuity-hardening-2026-07-07 P-007).
 * The core is a per-surface, idempotent from→to migration over injected sql.
 * Load-bearing contracts: the from-appears-live LIVENESS guard (never steal a
 * live peer's identity — but never force the legitimate warm-dead rebind onto
 * `force:true` either), collision semantics (the LIVE id's row / the NEWER
 * carry-note wins; a duplicate active await is cancelled, not doubled), the
 * append-only fleet fact discipline, and per-surface error isolation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  rebindIdentity,
  REBIND_BLOCKING_SESSION_STATES,
  type FromLivenessVerdict,
  type RebindIdentityOpts,
} from './rebind-identity';
import type { SessionState } from './presence-wakeability';
import { loopRoutineId, loopRoutineName } from '../../harness/routines/loop';

const NOW = 1_800_000_000_000;
const FROM = 'su-old-aaaa';
const TO = 'su-new-bbbb';

interface FakeCall {
  text: string;
  vals: unknown[];
}

interface FakeOpts {
  /** Does the from-id still hold a plan/work-item claim? (suspect-vs-ended input) */
  claimsHeld?: boolean;
  loops?: Array<{ id: string; install_slug: string }>;
  /** New loop ids that already exist (the live id armed its own loop). */
  loopIdExists?: string[];
  notes?: Array<{ workspace_id: string; scope: string; updated_ts: string }>;
  /** target-scope → updated_ts for pre-existing to-side notes. */
  noteClash?: Record<string, string>;
  presenceDrop?: number;
  fleetLatest?: { workspace_id: string; owner_label: string | null; fleet_slug: string | null; fleet_role: string | null } | null;
  launchSpecFleet?: { workspace_id: string; owner_label: string | null; fleet_slug: string | null; fleet_role: string | null } | null;
  fleetToLatest?: { fleet_slug: string | null } | null;
  leaderSlugs?: string[];
  claimSpecDrop?: number;
  claimSpecMove?: number;
  /** Retained claim-spec revision rows re-keyed (migration 810). */
  claimSpecHistoryMove?: number;
  awaits?: Array<{ id: number; workspace_id: string; event_key: string }>;
  /** Rewritten event keys that already have an identical active to-await. */
  awaitDupKeys?: string[];
  /** Open + expired consult rows whose participant ownership follows the live id. */
  consultParticipants?: number;
  planClaims?: number;
  workClaims?: number;
  wmDrop?: number;
  wmMove?: number;
  heldItems?: number;
  heldWorkItems?: number;
  factsDrop?: number;
  factsMove?: number;
  ownerDirectives?: number;
  agentModesDrop?: number;
  agentModesMove?: number;
  pendingWakes?: number;
  cursorDrop?: number;
  cursorMove?: number;
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
    // The liveness guard's ONLY sql read: the claimsHeld EXISTS probe. The
    // verdict itself comes through the injected `resolveLiveness` seam.
    if (text.includes('SELECT (EXISTS')) return Promise.resolve([{ held: !!opts.claimsHeld }]);
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
    if (text.includes('FROM harness_shared.adv_sessions AS adv')) {
      return Promise.resolve(opts.launchSpecFleet ? [opts.launchSpecFleet] : []);
    }
    if (text.includes('SELECT fleet_slug FROM harness_shared.fleet_membership_events')) {
      return Promise.resolve(opts.fleetToLatest ? [opts.fleetToLatest] : []);
    }
    if (text.includes('UPDATE harness_shared.agent_fleets')) {
      // Real column is `fleet_slug` (mig 417) — NOT a bare `slug`; the mock
      // shape matches the real `RETURNING fleet_slug` so this fake can't mask
      // a query that regresses to the wrong column name (WI-5386's real-DB
      // regression test — rebind-identity-fleet-leadership.integration.test.ts
      // — is what actually catches that class of bug; this mock's job is only
      // to stay honest about the shape).
      return Promise.resolve((opts.leaderSlugs ?? []).map((fleet_slug) => ({ fleet_slug })));
    }
    if (text.includes('DELETE FROM harness_shared.cup_claim_specs')) {
      return Promise.resolve(rows(opts.claimSpecDrop, { bee_id: FROM }));
    }
    if (text.includes('UPDATE harness_shared.cup_claim_specs')) {
      return Promise.resolve(rows(opts.claimSpecMove, { bee_id: TO }));
    }
    // Distinct from the matcher above on purpose: 'cup_claim_spec_revisions' does NOT
    // contain the substring 'cup_claim_specs' (the char after `spec` is `_`, not `s`),
    // so the two never capture each other regardless of order.
    if (text.includes('UPDATE harness_shared.cup_claim_spec_revisions')) {
      return Promise.resolve(rows(opts.claimSpecHistoryMove, { id: '1' }));
    }
    if (text.includes('SELECT id, workspace_id, event_key FROM harness_shared.event_awaits')) {
      return Promise.resolve(opts.awaits ?? []);
    }
    if (text.includes('SELECT id FROM harness_shared.event_awaits')) {
      return Promise.resolve((opts.awaitDupKeys ?? []).includes(String(vals[2])) ? [{ id: 999 }] : []);
    }
    if (text.includes('UPDATE harness_shared.consult_state SET requester_id')) {
      return Promise.resolve(rows(opts.consultParticipants, { conversation_id: 'consult-1' }));
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
    if (text.includes('UPDATE harness_shared.owner_directives')) {
      return Promise.resolve(rows(opts.ownerDirectives, { id: 7 }));
    }
    if (text.includes('DELETE FROM harness_shared.agent_modes')) {
      return Promise.resolve(rows(opts.agentModesDrop, { axis_key: 'overlay:goal' }));
    }
    if (text.includes('UPDATE harness_shared.agent_modes')) {
      return Promise.resolve(rows(opts.agentModesMove, { axis_key: 'overlay:goal' }));
    }
    if (text.includes('UPDATE harness_shared.pending_wakes')) {
      return Promise.resolve(rows(opts.pendingWakes, { id: 42 }));
    }
    if (text.includes('DELETE FROM harness_shared.coord_read_cursors')) {
      return Promise.resolve(rows(opts.cursorDrop, { owner_id: FROM }));
    }
    if (text.includes('UPDATE harness_shared.coord_read_cursors')) {
      return Promise.resolve(rows(opts.cursorMove, { owner_id: TO }));
    }
    // Remaining writes (routine/carry-note/await/fleet-event mutations) return no rows.
    return Promise.resolve([]);
  };
  return Object.assign(fn, { calls });
}

/**
 * A from-id whose session is OVER. This is the DEFAULT for every non-guard test
 * below, and it is the canonical relaunch shape: the predecessor's heartbeat is
 * still warm (`heartbeatFresh: true`) while its session has ended. The whole
 * point of gating on `sessionState` is that this rebinds with NO force — under
 * the old heartbeat-age gate this exact verdict was refused.
 */
const warmDead = async (): Promise<FromLivenessVerdict> => ({ sessionState: 'ended', heartbeatFresh: true });

/** Resolve the from-id to a fixed state, and record the hints it was handed. */
const resolvesTo = (state: SessionState, heartbeatFresh = true) => {
  const seen: Array<{ claimsHeld: boolean; nowMs: number }> = [];
  const fn = async (_from: string, hints: { claimsHeld: boolean; nowMs: number }) => {
    seen.push(hints);
    return { sessionState: state, heartbeatFresh };
  };
  return Object.assign(fn, { seen });
};

const rebind = (
  f: string,
  t: string,
  sql: unknown,
  extra: Partial<RebindIdentityOpts> = {},
) => rebindIdentity(f, t, { sql: sql as never, now: NOW, resolveLiveness: warmDead, ...extra });

const surfaceOf = (res: Awaited<ReturnType<typeof rebindIdentity>>, name: string) => {
  const s = res.surfaces.find((x) => x.surface === name);
  expect(s, `surface ${name} missing`).toBeTruthy();
  return s!;
};

/**
 * Every re-key surface rebindIdentity() visits when the caller wires NO
 * rebindLockOwner. Authored here deliberately rather than derived from the
 * tool: adding a surface SHOULD have to be acknowledged in this file, because
 * a surface the tool forgets is a claim that silently outlives its session.
 *
 * It is a NAMED LIST and not a bare count because the count alone reports the
 * wrong thing. When `interest-watches` landed, six independent
 * `toHaveLength(16)` assertions each failed as "expected 17 to have a length
 * of 16" — which names neither the new surface nor the file that has to change,
 * and reads like six separate defects. The whole green-checkpoint gate sat red
 * behind that for hours. Compared against a list, the same change fails once
 * and prints the newcomer's name.
 */
const BASE_SURFACES = [
  'loop-routine',
  'carry-note',
  'presence',
  'fleet-membership',
  'fleet-leadership',
  'claim-spec',
  'awaits',
  'interest-watches',
  'consult-participants',
  'plan-claims',
  'work-claims',
  'watermarks',
  'held-items',
  'held-work-items',
  'owner-facts',
  'owner-directives',
  'agent-modes',
  'read-cursors',
  'pending-wakes',
] as const;

/** `file-locks` is opt-in — present only when the caller wires rebindLockOwner. */
const WITH_FILE_LOCKS = [...BASE_SURFACES, 'file-locks'] as const;

/** Assert the visited surface SET, so a drift names the surface that drifted. */
const expectSurfaces = (
  res: Awaited<ReturnType<typeof rebindIdentity>>,
  expected: readonly string[] = BASE_SURFACES,
) => {
  expect([...res.surfaces.map((s) => s.surface)].sort()).toEqual([...expected].sort());
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

  it.each(REBIND_BLOCKING_SESSION_STATES)(
    'refuses a from-id the oracle derives as %s (never steal a live peer)',
    async (state) => {
      const sql = fakeSql();
      const res = await rebind(FROM, TO, sql, { resolveLiveness: resolvesTo(state) });
      expect(res).toMatchObject({ ok: false, refused: 'from_appears_live', fromSessionState: state });
      expect(res.surfaces).toHaveLength(0);
      // Only the guard's claimsHeld probe ran — no surface was touched.
      expect(sql.calls).toHaveLength(1);
    },
  );

  it.each(['ended', 'suspect'] as const)(
    'rebinds a %s from-id with NO force even while its heartbeat is still WARM',
    async (state) => {
      // The regression this guard was rewritten for (EI-20273348458054257): a
      // relaunched session's predecessor keeps a fresh beat for minutes after
      // its turn ends. Gating on heartbeat age refused this and pushed the
      // happy path onto `force:true`; gating on sessionState lets it through.
      const sql = fakeSql();
      const res = await rebind(FROM, TO, sql, { resolveLiveness: resolvesTo(state, true) });
      expect(res.ok).toBe(true);
      expect(res).toMatchObject({ fromSessionState: state, fromHeartbeatFresh: true });
      expect(res.refused).toBeUndefined();
      expectSurfaces(res);
    },
  );

  it('hands the oracle the from-id\'s REAL claimsHeld — the input that separates suspect from ended', async () => {
    for (const claimsHeld of [true, false]) {
      const resolve = resolvesTo('ended');
      await rebind(FROM, TO, fakeSql({ claimsHeld }), { resolveLiveness: resolve });
      expect(resolve.seen).toEqual([{ claimsHeld, nowMs: NOW }]);
    }
  });

  it('proceeds under force even when the oracle says the from-id is LIVE', async () => {
    const resolve = resolvesTo('live');
    const res = await rebind(FROM, TO, fakeSql(), { force: true, resolveLiveness: resolve });
    expect(res.ok).toBe(true);
    expectSurfaces(res);
    // force skips the guard entirely — the oracle is never consulted.
    expect(resolve.seen).toHaveLength(0);
  });

  it('fails OPEN when the oracle returns no verdict, or the guard read throws', async () => {
    for (const opts of [
      { sql: fakeSql(), resolveLiveness: async () => null },
      { sql: fakeSql({ failOn: /SELECT \(EXISTS/ }), resolveLiveness: warmDead },
    ]) {
      const res = await rebind(FROM, TO, opts.sql, { resolveLiveness: opts.resolveLiveness });
      expect(res.ok).toBe(true);
      expectSurfaces(res);
    }
  });

  /**
   * FALSIFIABILITY CONTROL (repo discipline: a deliberately-wrong implementation
   * kept permanently in the TEST file — never a mutation of the shared tree).
   * This is the gate exactly as it was before EI-20273348458054257: refuse while
   * the from-id's beat is younger than the 180s live window. Kept so the
   * regression below cannot silently pass against a reverted implementation.
   */
  const legacyHeartbeatGate = (heartbeatAgoMs: number) => heartbeatAgoMs < 180_000;

  it('the OLD heartbeat gate refuses the warm-dead rebind that the CURRENT gate admits', async () => {
    // The control is wrong about the case that matters...
    expect(legacyHeartbeatGate(30_000)).toBe(true); // would refuse — the defect
    const res = await rebind(FROM, TO, fakeSql(), { resolveLiveness: resolvesTo('ended', true) });
    expect(res.refused).toBeUndefined(); // ...the real subject admits it

    // ...and CALIBRATION: on a genuinely live peer both agree to refuse, so the
    // control is discriminating between these two cases, not just always-refuse.
    expect(legacyHeartbeatGate(30_000)).toBe(true);
    const live = await rebind(FROM, TO, fakeSql(), { resolveLiveness: resolvesTo('live', true) });
    expect(live.refused).toBe('from_appears_live');
  });

  it('never gates on the raw heartbeat: a WARM beat alone cannot refuse, a COLD one alone cannot admit', async () => {
    // The defect in one assertion. `heartbeatFresh` is process-keepalive
    // freshness, not a liveness verdict, so it must not move the decision in
    // EITHER direction — only `sessionState` may.
    const warmButEnded = await rebind(FROM, TO, fakeSql(), { resolveLiveness: resolvesTo('ended', true) });
    expect(warmButEnded.refused).toBeUndefined();
    const coldButParked = await rebind(FROM, TO, fakeSql(), { resolveLiveness: resolvesTo('parked', false) });
    expect(coldButParked).toMatchObject({ refused: 'from_appears_live', fromHeartbeatFresh: false });
  });
});

describe('armed loop routine', () => {
  it('re-keys id + name + target_owner_id and text-replaces the sid inside payload_template', async () => {
    const oldId = loopRoutineId('papercusp', FROM);
    const sql = fakeSql({ loops: [{ id: oldId, install_slug: 'papercusp' }] });
    const res = await rebind(FROM, TO, sql);
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
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'loop-routine')).toMatchObject({ moved: 0, dropped: 1 });
    const del = sql.calls.find((c) => c.text.includes('DELETE FROM harness_shared.routines'));
    expect(del!.vals).toContain(oldId);
  });
});

describe('loop carry-note (+walls) scope rows', () => {
  const note = (scope: string, ts = '2026-07-07T10:00:00Z') => ({ workspace_id: 'coord-ws', scope, updated_ts: ts });

  it('moves both the loop and loopnag scopes to the live id', async () => {
    const sql = fakeSql({ notes: [note(`loop:papercusp:${FROM}`), note(`loopnag:papercusp:${FROM}`)] });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'carry-note')).toMatchObject({ moved: 2 });
    const updates = sql.calls.filter((c) => c.text.includes('UPDATE harness_shared.carry_notes'));
    expect(updates.map((u) => u.vals[0])).toEqual([`loop:papercusp:${TO}`, `loopnag:papercusp:${TO}`]);
  });

  it('a FRESHER to-side note wins: the ghost from-row is dropped, never clobbers', async () => {
    const sql = fakeSql({
      notes: [note(`loop:papercusp:${FROM}`, '2026-07-07T10:00:00Z')],
      noteClash: { [`loop:papercusp:${TO}`]: '2026-07-07T11:00:00Z' },
    });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'carry-note')).toMatchObject({ moved: 0, dropped: 1 });
    expect(sql.calls.some((c) => c.text.includes('UPDATE harness_shared.carry_notes'))).toBe(false);
  });

  it('a STALER to-side note is replaced by the from-note (walls carry-forward truth)', async () => {
    const sql = fakeSql({
      notes: [note(`loop:papercusp:${FROM}`, '2026-07-07T12:00:00Z')],
      noteClash: { [`loop:papercusp:${TO}`]: '2026-07-07T11:00:00Z' },
    });
    const res = await rebind(FROM, TO, sql);
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
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'awaits')).toMatchObject({ moved: 1, cancelled: 1 });
    const cancel = sql.calls.find((c) => c.text.includes('SET cancelled_at'));
    expect(cancel!.vals).toContain(1);
    const move = sql.calls.find((c) => c.text.includes('SET subscriber_id'));
    expect(move!.vals).toEqual([TO, 'work-item:done:WI-9', 2]);
  });
});

describe('actionable consult participant ownership (EI-21457373491665728)', () => {
  it('re-keys open and expired requester/responder roles, including the requester-only late close', async () => {
    const sql = fakeSql({ consultParticipants: 2 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'consult-participants')).toMatchObject({ moved: 2 });

    const update = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.consult_state SET requester_id'));
    expect(update).toBeTruthy();
    expect(update!.vals).toEqual([FROM, TO, FROM, TO, FROM, FROM]);
    expect(update!.text).toContain('requester_id = CASE WHEN requester_id =');
    expect(update!.text).toContain('responder_id = CASE WHEN responder_id =');
    expect(update!.text).toContain('requester_id = ? OR responder_id = ?');
    expect(update!.text).toContain("closed_at IS NULL OR state = 'expired'");
    // Closed / declined history is intentionally not rewritten: unlike an
    // expired row, it carries no requester-only action for the successor.
    expect(update!.text).not.toContain("state = 'closed_answered'");
  });
});

describe('fleet membership (append-only) + leadership', () => {
  it('closes the old membership with a leave-fact and re-opens the fleet+role under the live id', async () => {
    const sql = fakeSql({
      fleetLatest: { workspace_id: 'coord-ws', owner_label: 'su · su-old', fleet_slug: 'bug-drain', fleet_role: 'leader' },
      fleetToLatest: null,
      leaderSlugs: ['bug-drain'],
    });
    const res = await rebind(FROM, TO, sql);
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
    const res1 = await rebind(FROM, TO, inFleet);
    expect(surfaceOf(res1, 'fleet-membership')).toMatchObject({ appended: 1 }); // just the leave
    const noFleet = fakeSql({ fleetLatest: { workspace_id: 'coord-ws', owner_label: null, fleet_slug: null, fleet_role: null } });
    const res2 = await rebind(FROM, TO, noFleet);
    expect(surfaceOf(res2, 'fleet-membership').appended).toBeUndefined();
  });

  it('restores the successor fleet from launch_spec when the predecessor has no membership fact', async () => {
    const sql = fakeSql({
      launchSpecFleet: {
        workspace_id: 'coord-ws',
        owner_label: 'member 3',
        fleet_slug: 'bug-drain',
        fleet_role: 'member',
      },
    });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'fleet-membership')).toMatchObject({ appended: 1 });
    const inserts = sql.calls.filter((c) => c.text.includes('INSERT INTO harness_shared.fleet_membership_events'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].vals).toContain(TO);
    expect(inserts[0].vals).toContain('bug-drain');
    expect(inserts[0].vals).toContain('member');
    expect(inserts[0].vals).toContain('join');
  });

  it('does not resurrect an explicitly recorded leave from the launch snapshot', async () => {
    const sql = fakeSql({
      fleetLatest: { workspace_id: 'coord-ws', owner_label: null, fleet_slug: null, fleet_role: null },
      launchSpecFleet: {
        workspace_id: 'coord-ws',
        owner_label: 'member 3',
        fleet_slug: 'bug-drain',
        fleet_role: 'member',
      },
    });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'fleet-membership').appended).toBeUndefined();
    expect(sql.calls.some((c) => c.text.includes('FROM harness_shared.adv_sessions AS adv'))).toBe(false);
  });
});

describe('claim-spec revision history follows the lane (migration 810, EI-18677010014746233)', () => {
  it('re-keys the retained history, counted apart from the live row', async () => {
    // Left behind, the history is orphaned under a dead id and the rebound agent's
    // `scheduler:get_claim_spec { cupId, history }` returns an EMPTY window — which
    // reads as "this lane has no history", not "it is filed under the id you no longer
    // are". That is the undo for a destructive spec write going quietly missing for
    // exactly the agent who just survived a fork.
    const sql = fakeSql({ claimSpecMove: 1, claimSpecHistoryMove: 4 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'claim-spec')).toMatchObject({ moved: 1, movedHistory: 4 });
  });

  it('moves history AFTER the live-side DELETE, so the row that DELETE creates is not stranded', async () => {
    // ORDER IS LOAD-BEARING, and a reordering would look harmless. The surface's own
    // DELETE (live-side-wins) fires migration 810's retention trigger, which writes ONE
    // MORE revision row keyed on the GHOST id. Moving history before that runs leaves
    // precisely the row this rebind just created behind.
    const sql = fakeSql({ claimSpecDrop: 1, claimSpecHistoryMove: 2 });
    await rebind(FROM, TO, sql);
    const idx = (needle: string) => sql.calls.findIndex((c) => c.text.includes(needle));
    const del = idx('DELETE FROM harness_shared.cup_claim_specs');
    const history = idx('UPDATE harness_shared.cup_claim_spec_revisions');
    expect(del, 'live-side DELETE not issued').toBeGreaterThan(-1);
    expect(history, 'history re-key not issued').toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(del);
  });

  it('re-keys history unconditionally — not only when a live row moved', async () => {
    // A CLEARED lane has no live row at all, and its history is the only thing left to
    // recover. Gating the history move on `moved > 0` would skip exactly that case.
    const sql = fakeSql({ claimSpecMove: 0, claimSpecDrop: 0, claimSpecHistoryMove: 3 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'claim-spec')).toMatchObject({ moved: 0, movedHistory: 3 });
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
      ownerDirectives: 2,
      pendingWakes: 3,
      cursorDrop: 1,
      cursorMove: 1,
    });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'presence')).toMatchObject({ dropped: 1 });
    expect(surfaceOf(res, 'claim-spec')).toMatchObject({ moved: 0, dropped: 1 });
    expect(surfaceOf(res, 'plan-claims')).toMatchObject({ moved: 2 });
    expect(surfaceOf(res, 'work-claims')).toMatchObject({ moved: 3 });
    expect(surfaceOf(res, 'watermarks')).toMatchObject({ moved: 1, dropped: 1 });
    expect(surfaceOf(res, 'held-items')).toMatchObject({ moved: 4 });
    expect(surfaceOf(res, 'held-work-items')).toMatchObject({ moved: 5 });
    expect(surfaceOf(res, 'owner-facts')).toMatchObject({ moved: 2, dropped: 1 });
    expect(surfaceOf(res, 'owner-directives')).toMatchObject({ moved: 2 });
    expect(surfaceOf(res, 'pending-wakes')).toMatchObject({ moved: 3 });
    expect(surfaceOf(res, 'read-cursors')).toMatchObject({ moved: 1, dropped: 1 });
    expect(res.totalMoved).toBe(28);
    expect(res.ok).toBe(true);
  });

  it('read-cursors (EI-8999, migration 537) re-keys coord_read_cursors, live-side-wins on a (workspace,surface) collision', async () => {
    const sql = fakeSql({ cursorMove: 2 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'read-cursors')).toMatchObject({ moved: 2 });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.coord_read_cursors SET owner_id'));
    expect(upd).toBeTruthy();
    expect(upd!.vals).toEqual([TO, FROM]);
  });

  it('pending-wakes (EI-8999) re-keys staged manual-mode wakes so a compaction rebind never strands one under the dead sid', async () => {
    const sql = fakeSql({ pendingWakes: 2 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'pending-wakes')).toMatchObject({ moved: 2 });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.pending_wakes SET owner_id'));
    expect(upd).toBeTruthy();
    expect(upd!.vals).toEqual([TO, FROM]);
  });

  it('owner-directives re-keys only OPEN binding instructions; dispositioned history stays attributed to its originating sid', async () => {
    const sql = fakeSql({ ownerDirectives: 2 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'owner-directives')).toMatchObject({ moved: 2 });
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.owner_directives SET owner_id'));
    expect(upd).toBeTruthy();
    expect(upd!.text).toContain('dispositioned_at IS NULL');
    expect(upd!.vals).toEqual([TO, FROM]);
  });

  it('agent-modes re-keys live GOAL/AUTO/DRAIN posture and preserves the successor row on an axis collision', async () => {
    const sql = fakeSql({ agentModesDrop: 1, agentModesMove: 3 });
    const res = await rebind(FROM, TO, sql);
    expect(surfaceOf(res, 'agent-modes')).toMatchObject({ moved: 3, dropped: 1 });

    const drop = sql.calls.find((c) => c.text.includes('DELETE FROM harness_shared.agent_modes'));
    expect(drop).toBeTruthy();
    expect(drop!.text).toContain('from_mode.owner_id = ?');
    expect(drop!.text).toContain('to_mode.owner_id = ?');
    expect(drop!.text).toContain('to_mode.axis_key = from_mode.axis_key');
    const move = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.agent_modes'));
    expect(move).toBeTruthy();
    expect(move!.vals).toEqual([TO, FROM]);
  });

  it('held-items re-key excludes terminal states (history keeps its author)', async () => {
    const sql = fakeSql({ heldItems: 1 });
    await rebind(FROM, TO, sql);
    const upd = sql.calls.find((c) => c.text.includes('UPDATE harness_shared.engineer_issues'));
    expect(upd!.text).toContain("state NOT IN ('done', 'resolved', 'deprecated', 'closed')");
  });

  it('held-work-items (WI-3642) re-keys work_items.taken_by directly, covering EVERY item_kind, excluding terminal statuses', async () => {
    const sql = fakeSql({ heldWorkItems: 2 });
    const res = await rebind(FROM, TO, sql);
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
    const res = await rebind(FROM, TO, sql);
    expect(res.ok).toBe(false);
    expect(surfaceOf(res, 'fleet-leadership').error).toContain('surface exploded');
    expectSurfaces(res);
    expect(surfaceOf(res, 'plan-claims')).toMatchObject({ moved: 1 });
  });
});

describe('SU-locks file locks + waiters (EI-8999/P-002 — opt-in, separate side-database)', () => {
  it('is entirely SKIPPED when the caller does not wire rebindLockOwner — no I/O attempted, surface count unchanged', async () => {
    const sql = fakeSql();
    const res = await rebind(FROM, TO, sql);
    expectSurfaces(res);
    expect(res.surfaces.find((s) => s.surface === 'file-locks')).toBeUndefined();
  });

  it('is called + folded into totalMoved when the caller wires it (the production tool always does)', async () => {
    const sql = fakeSql();
    const rebindLockOwner = vi.fn().mockResolvedValue({ fileLocksMoved: 2, waitersMoved: 1 });
    const res = await rebind(FROM, TO, sql, { rebindLockOwner });
    expectSurfaces(res, WITH_FILE_LOCKS);
    expect(surfaceOf(res, 'file-locks')).toMatchObject({ moved: 3 });
    expect(rebindLockOwner).toHaveBeenCalledWith(FROM, TO);
    expect(res.totalMoved).toBeGreaterThanOrEqual(3);
  });

  it('a throwing rebindLockOwner is isolated like any other surface — recorded as an error, never sinks the rest', async () => {
    const sql = fakeSql({ planClaims: 1 });
    const rebindLockOwner = vi.fn().mockRejectedValue(new Error('papercusp_su unreachable'));
    const res = await rebind(FROM, TO, sql, { rebindLockOwner });
    expect(res.ok).toBe(false);
    expect(surfaceOf(res, 'file-locks').error).toContain('papercusp_su unreachable');
    expect(surfaceOf(res, 'plan-claims')).toMatchObject({ moved: 1 });
  });
});
