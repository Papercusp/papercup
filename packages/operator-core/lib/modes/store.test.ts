/**
 * Mode store semantics (modes-and-intake-ux-2026-07-05 P-006):
 * axis auto-switch (D-006), owner-sticky refusal (D-003), clear/no-op paths,
 * and the append-only audit — over a mock sql seam (no PG).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { setMode, getModes, getModesForOwners, reconcileImpliedModes, RECONCILE_SET_BY } from './store';
import { MODES, modeById, axisKeyFor, modeIndexMarkdown } from './registry';

interface Row {
  workspace_id: string;
  owner_id: string;
  axis_key: string;
  mode: string;
  reason: string;
  set_by: string;
  owner_directed: boolean;
  set_at: string;
  /* Modelled because GOAL's whole provenance chain hangs off it —
     work_items.goal_id is stamped FROM agent_modes.subject. A mock that drops
     the column answers "subject: null" to every question, which is
     indistinguishable from the bug where the column is never written. */
  subject: string | null;
}

/** In-memory agent_modes + agent_mode_changes behind a postgres.js-shaped tagged template. */
function mockSql() {
  const modes = new Map<string, Row>();
  const changes: Array<Record<string, unknown>> = [];
  const key = (ws: string, o: string, a: string) => `${ws}|${o}|${a}`;

  const fn = (first: unknown, ...vals: unknown[]): unknown => {
    // A tagged-template call receives a TemplateStringsArray (has .raw);
    // sql(array) — the IN (...) helper — receives a plain array.
    if (!Array.isArray(first) || !('raw' in (first as object))) return { __in: first };
    const text = (first as string[]).join('¤').replace(/\s+/g, ' ');
    if (text.includes('INSERT INTO harness_shared.agent_mode_changes')) {
      const [ws, owner, axis, oldMode, newMode, reason, setBy, ownerDirected] = vals;
      changes.push({ ws, owner, axis, oldMode, newMode, reason, setBy, ownerDirected });
      return Promise.resolve([]);
    }
    if (text.includes('INSERT INTO harness_shared.agent_modes')) {
      const [ws, owner, axis, mode, reason, setBy, ownerDirected, subject] = vals as string[];
      const k = key(ws, owner, axis);
      /* TWO different inserts hit this branch and they must NOT be modelled the
         same way (D-003). The primary write is ON CONFLICT DO UPDATE — an upsert
         that displaces the same-axis incumbent. The implication cascade is
         ON CONFLICT DO NOTHING … RETURNING mode — "adopt this axis only if it is
         free", whose whole purpose is that it CANNOT displace.
         A mock that ignores the conflict clause returns a well-formed answer to
         the question asked while doing the opposite of what PG would: it
         overwrites on conflict (breaking the never-displace property this mock
         is supposed to prove) and returns no RETURNING row (so the caller reads
         a successful insert as a conflict). Both errors are invisible from a
         green run — the row is there either way. */
      const doNothing = text.includes('DO NOTHING');
      if (doNothing && modes.has(k)) return Promise.resolve([]); // PK conflict: no write, no row
      modes.set(k, {
        workspace_id: ws, owner_id: owner, axis_key: axis, mode,
        reason, set_by: setBy, owner_directed: Boolean(ownerDirected), set_at: '2026-07-05T00:00:00Z',
        subject: subject ?? null,
      });
      return Promise.resolve(doNothing ? [{ mode }] : []); // RETURNING mode
    }
    // The cascade's "who holds this axis instead" report read.
    if (text.includes('SELECT mode FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      const row = modes.get(key(ws, owner, axis));
      return Promise.resolve(row ? [{ mode: row.mode }] : []);
    }
    if (text.includes('DELETE FROM harness_shared.agent_modes')) {
      const [ws, owner, axis] = vals as string[];
      modes.delete(key(ws, owner, axis));
      return Promise.resolve([]);
    }
    if (text.includes('SELECT * FROM harness_shared.agent_modes')) {
      if (text.includes('axis_key =')) {
        const [ws, owner, axis] = vals as string[];
        const row = modes.get(key(ws, owner, axis));
        return Promise.resolve(row ? [row] : []);
      }
      if (text.includes('IN')) {
        const [ws, inArg] = vals as [string, { __in: string[] }];
        const owners = new Set(inArg.__in);
        return Promise.resolve([...modes.values()].filter((r) => r.workspace_id === ws && owners.has(r.owner_id)));
      }
      const [ws, owner] = vals as string[];
      return Promise.resolve([...modes.values()].filter((r) => r.workspace_id === ws && r.owner_id === owner));
    }
    throw new Error(`mockSql: unrecognized query: ${text.slice(0, 80)}`);
  };
  return { sql: fn as unknown as Sql, modes, changes };
}

const WS = 'test-ws';
const ME = 'su-me';
const PEER = 'su-peer';

describe('mode registry', () => {
  it('covers the seven official modes with correct axes (owner correction: ideate/drain are stackable overlays)', () => {
    expect(MODES.map((m) => m.id).sort()).toEqual([
      'auto',
      'cold-auto',
      'drain',
      'goal',
      'grade',
      'ideate',
      'test',
    ]);
    expect(modeById('auto')?.axis).toBe('autonomy');
    expect(modeById('cold-auto')?.axis).toBe('autonomy');
    expect(modeById('ideate')?.axis).toBe('overlay');
    expect(modeById('drain')?.axis).toBe('overlay');
    expect(modeById('grade')?.axis).toBe('overlay');
    expect(modeById('goal')?.axis).toBe('overlay');
    // TEST (goal-mode-hardening-2026-08-10 P-006): an overlay that deliberately
    // implies nothing — testing is not an autonomy posture.
    expect(modeById('test')?.axis).toBe('overlay');
  });

  it('axis keys: the autonomy family shares a key; each overlay gets its own', () => {
    expect(axisKeyFor(modeById('auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('cold-auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('ideate')!)).toBe('overlay:ideate');
    expect(axisKeyFor(modeById('drain')!)).toBe('overlay:drain');
    expect(axisKeyFor(modeById('grade')!)).toBe('overlay:grade');
    expect(axisKeyFor(modeById('goal')!)).toBe('overlay:goal');
    expect(axisKeyFor(modeById('test')!)).toBe('overlay:test');
  });

  it('every mode has a one-liner and a non-trivial contract; the index lists them all', () => {
    for (const m of MODES) {
      expect(m.oneLiner.length).toBeGreaterThan(20);
      expect(m.oneLiner).not.toContain('\n');
      expect(m.contract.length).toBeGreaterThan(200);
    }
    const idx = modeIndexMarkdown();
    for (const m of MODES) expect(idx).toContain(`**${m.id}**`);
  });

  it('P-014 (su-ideate-learning-substrate): IDEATE contract splices the su closed-loop ritual; GRADE notes the originator-wake', () => {
    const ideate = modeById('ideate')!.contract;
    // The su learning ritual: ground → file lens-tagged → route broad → close with a ledgered tick.
    expect(ideate).toContain('blender:ideation-feedback');
    expect(ideate).toContain('blender:route-idea');
    expect(ideate).toContain('blender:ideate-pass-record');
    const grade = modeById('grade')!.contract;
    expect(grade).toContain('blender:grade-idea');
    expect(grade).toMatch(/WAKES its\s+originator/);
    // one-liners stay stable (P-014: the always-present index is untouched).
    expect(modeById('ideate')!.oneLiner).not.toContain('\n');
    expect(modeById('grade')!.oneLiner).not.toContain('\n');
  });
});

describe('setMode semantics', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => { m = mockSql(); });

  it('self-set enables a mode and audits it', async () => {
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'owner said auto', setBy: ME, ownerDirected: true, sql: m.sql });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBeNull();
    const rows = await getModes(WS, ME, m.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('auto');
    expect(rows[0].ownerDirected).toBe(true);
    expect(m.changes).toHaveLength(1);
    expect(m.changes[0]).toMatchObject({ oldMode: null, newMode: 'auto' });
  });

  it('AUTO-SWITCH: setting cold-auto replaces auto (same autonomy axis) and reports switchedFrom', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'r1', setBy: ME, sql: m.sql });
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'cold-auto', enabled: true, reason: 'r2', setBy: ME, sql: m.sql });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBe('auto');
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['cold-auto']);
    expect(m.changes.at(-1)).toMatchObject({ oldMode: 'auto', newMode: 'cold-auto' });
  });

  it('overlays stack — including ideate + drain together (owner correction 2026-07-05)', async () => {
    for (const mode of ['auto', 'ideate', 'drain', 'grade']) {
      await setMode({ workspaceId: WS, ownerId: ME, modeId: mode, enabled: true, reason: 'stack', setBy: ME, sql: m.sql });
    }
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'drain', 'grade', 'ideate']);
  });

  it('OWNER-STICKY: a peer cannot override or clear an owner-directed mode', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'owner freeze posture', setBy: ME, ownerDirected: true, sql: m.sql });
    const override = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'cold-auto', enabled: true, reason: 'peer thinks cold is better', setBy: PEER, sql: m.sql });
    expect(override.ok).toBe(false);
    expect(override.stickyConflict).toBe(true);
    const clear = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: false, reason: 'peer clears', setBy: PEER, sql: m.sql });
    expect(clear.ok).toBe(false);
    expect(clear.stickyConflict).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['auto']); // untouched
    expect(m.changes).toHaveLength(1); // refusals write NOTHING
  });

  it('a peer CAN set a non-sticky mode, and the write is attributed to the peer', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'ideate', enabled: true, reason: 'self', setBy: ME, sql: m.sql });
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'drain', enabled: true, reason: 'backlog is critical', setBy: PEER, sql: m.sql });
    expect(res.ok).toBe(true);
    expect(res.switchedFrom).toBeNull(); // overlays stack — ideate survives
    const rows = await getModes(WS, ME, m.sql);
    // 'auto' is here because DRAIN implies it and the store now writes it (D-003) —
    // this expectation moved from ['drain','ideate'] on purpose.
    expect(rows.map((r) => r.mode).sort()).toEqual(['auto', 'drain', 'ideate']);
    expect(res.implied).toEqual([{ mode: 'auto', status: 'set' }]);
    // A peer-driven implication is still attributed to the peer, and a peer can
    // no more arm sticky through an implication than through a direct set.
    const auto = rows.find((r) => r.mode === 'auto')!;
    expect(auto.setBy).toBe(PEER);
    expect(auto.ownerDirected).toBe(false);
    const drain = rows.find((r) => r.mode === 'drain')!;
    expect(drain.setBy).toBe(PEER);
    expect(drain.ownerDirected).toBe(false); // peers can never arm sticky for others
  });

  it('peers cannot arm ownerDirected for someone else even if they pass it', async () => {
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'x', setBy: PEER, ownerDirected: true, sql: m.sql });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
  });

  it('clearing an unset mode is a no-op; re-setting the same mode+reason is a no-op', async () => {
    const clear = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'drain', enabled: false, reason: 'not on', setBy: ME, sql: m.sql });
    expect(clear.ok).toBe(true);
    expect(clear.noop).toBe(true);
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'grade', enabled: true, reason: 'same', setBy: ME, sql: m.sql });
    const again = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'grade', enabled: true, reason: 'same', setBy: ME, sql: m.sql });
    expect(again.noop).toBe(true);
    expect(m.changes).toHaveLength(1);
  });

  it('unknown mode is rejected', async () => {
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'turbo', enabled: true, reason: 'x', setBy: ME, sql: m.sql });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown mode');
  });

  it('getModesForOwners fans in per owner', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true, reason: 'a', setBy: ME, sql: m.sql });
    await setMode({ workspaceId: WS, ownerId: PEER, modeId: 'grade', enabled: true, reason: 'b', setBy: PEER, sql: m.sql });
    const map = await getModesForOwners(WS, [ME, PEER, 'su-nobody'], m.sql);
    expect(map.get(ME)?.map((r) => r.mode)).toEqual(['auto']);
    expect(map.get(PEER)?.map((r) => r.mode)).toEqual(['grade']);
    expect(map.has('su-nobody')).toBe(false);
  });
});

describe('setMode callerIsOwnerAuthority (P-003: admin-UI peer-set is a verified owner-authority channel)', () => {
  let m: ReturnType<typeof mockSql>;
  const ADMIN = 'pc-admin-coord-ui';
  beforeEach(() => { m = mockSql(); });

  it('self-set: ownerAuthorized is implied — arms sticky without callerIsOwnerAuthority', async () => {
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true,
      reason: 'owner said auto', setBy: ME, ownerDirected: true, sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(true);
  });

  it('admin-UI peer-set with callerIsOwnerAuthority:true CAN arm the sticky flag (the P-003 fix)', async () => {
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true,
      reason: 'owner clicked Autonomy: auto in the chat UI', setBy: ADMIN,
      ownerDirected: true, callerIsOwnerAuthority: true, sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('auto');
    expect(rows[0].ownerDirected).toBe(true);
    expect(rows[0].setBy).toBe(ADMIN);
  });

  it('ordinary peer-set (no callerIsOwnerAuthority) claiming ownerDirected:true is DOWNGRADED — sticky never arms', async () => {
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true,
      reason: 'peer claims owner authority', setBy: PEER, ownerDirected: true, sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
    expect(rows[0].setBy).toBe(PEER);
  });

  it('admin-UI peer-set (callerIsOwnerAuthority:true) BYPASSES an existing owner-directed incumbent — an ordinary peer still cannot', async () => {
    await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: true,
      reason: 'owner froze this posture', setBy: ME, ownerDirected: true, sql: m.sql,
    });
    // An ordinary peer is still refused (unchanged D-003 behavior).
    const peerAttempt = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'cold-auto', enabled: true,
      reason: 'peer thinks cold is better', setBy: PEER, sql: m.sql,
    });
    expect(peerAttempt.ok).toBe(false);
    expect(peerAttempt.stickyConflict).toBe(true);

    // The admin-UI, acting for the owner, CAN override it — even without
    // re-claiming ownerDirected on this particular call.
    const adminOverride = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'cold-auto', enabled: true,
      reason: 'owner switched to cold-auto from the chat UI', setBy: ADMIN,
      callerIsOwnerAuthority: true, sql: m.sql,
    });
    expect(adminOverride.ok).toBe(true);
    expect(adminOverride.stickyConflict).toBeFalsy();
    expect(adminOverride.switchedFrom).toBe('auto');
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode)).toEqual(['cold-auto']);
  });

  it('admin-UI peer-set without ownerDirected:true does NOT itself arm sticky — callerIsOwnerAuthority only widens WHO can bypass/arm it', async () => {
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'ideate', enabled: true,
      reason: 'owner toggled the Overlays checkbox', setBy: ADMIN,
      callerIsOwnerAuthority: true, sql: m.sql,
    });
    expect(res.ok).toBe(true);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows[0].ownerDirected).toBe(false);
  });
});

/**
 * THE IMPLICATION CASCADE (D-003).
 *
 * [owner 2026-08-10] "make sure goal mode implies both auto and ideate mode."
 * The mechanism is the deliverable: entering GOAL must LEAVE the agent holding
 * auto + ideate whether or not anyone remembered a second call. These are
 * properties of the STORE, not of the `mode:set` tool, because three doors enter
 * a mode and only one of them is that tool.
 *
 * WHAT THIS SUITE CANNOT PROVE. The never-displace property rests on PG's
 * `ON CONFLICT … DO NOTHING`, which mockSql models by hand — so green here means
 * "the store asks for the right thing", not "PG does it". A live rolled-back
 * round-trip is what closes that half; this file is deliberately not trusted for
 * it.
 */
describe('implication cascade (D-003)', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => { m = mockSql(); });

  const enterGoal = (over: Partial<Parameters<typeof setMode>[0]> = {}) =>
    setMode({
      workspaceId: WS, ownerId: ME, modeId: 'goal', enabled: true,
      reason: 'owns goal g-1', setBy: ME, subject: 'g-1', sql: m.sql, ...over,
    });

  it('GOAL writes the auto AND ideate rows itself, and reports both', async () => {
    const res = await enterGoal();
    expect(res.ok).toBe(true);
    expect(res.implied).toEqual([
      { mode: 'auto', status: 'set' },
      { mode: 'ideate', status: 'set' },
    ]);
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
  });

  it('audits every implied entry — "who put this agent in AUTO" answers "the goal cascade"', async () => {
    await enterGoal();
    expect(m.changes.map((c) => c.newMode).sort()).toEqual(['auto', 'goal', 'ideate']);
    const autoChange = m.changes.find((c) => c.newMode === 'auto')!;
    expect(autoChange.oldMode).toBeNull();
    expect(String(autoChange.reason)).toContain("implied by 'goal'");
  });

  /**
   * THE PROPERTY MOST WORTH GUARDING. cold-auto already satisfies "implies
   * auto"; replacing it with plain auto would silently downgrade a posture the
   * agent deliberately chose. An ordinary upsert WOULD have replaced it — which
   * is precisely why the cascade is a DO NOTHING insert and not a setMode call.
   */
  it('NEVER displaces an occupied axis — cold-auto survives and is reported as holding it', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'cold-auto', enabled: true, reason: 'unattended wakes', setBy: ME, sql: m.sql });
    const res = await enterGoal();
    expect(res.implied).toEqual([
      { mode: 'auto', status: 'axis-held', by: 'cold-auto' },
      { mode: 'ideate', status: 'set' },
    ]);
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.map((r) => r.mode).sort()).toEqual(['cold-auto', 'goal', 'ideate']);
    // untouched, not merely present — a rewrite with the cascade's reason would
    // still leave cold-auto "there" while destroying who set it and why.
    expect(rows.find((r) => r.mode === 'cold-auto')!.reason).toBe('unattended wakes');
  });

  it('reports an implied mode the agent was already in as already-on, without a second write', async () => {
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'ideate', enabled: true, reason: 'was already ideating', setBy: ME, sql: m.sql });
    const before = m.changes.length;
    const res = await enterGoal();
    expect(res.implied).toContainEqual({ mode: 'ideate', status: 'already-on' });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'ideate')!.reason).toBe('was already ideating');
    expect(m.changes.length - before).toBe(2); // goal + auto only — ideate was not re-audited
  });

  /**
   * THE REPAIR PATH — and the reason the cascade is not gated on "something
   * changed". An agent whose auto row was cleared (a peer, a wipe) re-asserts
   * its mode to fix it; if a no-op mode write skipped the cascade, that one
   * natural call would be the one call that does nothing.
   */
  it('is IDEMPOTENT and REPAIRS: a no-op re-entry restores a missing implied row', async () => {
    await enterGoal();
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: false, reason: 'a peer cleared it', setBy: ME, sql: m.sql });
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['goal', 'ideate']);

    const again = await enterGoal(); // identical args ⇒ the mode write itself is a noop
    expect(again.noop).toBe(true);
    expect(again.implied).toEqual([
      { mode: 'auto', status: 'set' },
      { mode: 'ideate', status: 'already-on' },
    ]);
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'goal', 'ideate']);
  });

  /**
   * NOT MIRRORED ON EXIT, on purpose: the agent may have been in AUTO before it
   * ever entered GOAL, and revoking a posture the owner set independently is a
   * destructive guess. "Entering this means entering those" ≠ "these are mine".
   */
  it('does NOT clear implied modes when the implying mode is turned off', async () => {
    await enterGoal();
    await setMode({ workspaceId: WS, ownerId: ME, modeId: 'goal', enabled: false, reason: 'goal shipped', setBy: ME, sql: m.sql });
    expect((await getModes(WS, ME, m.sql)).map((r) => r.mode).sort()).toEqual(['auto', 'ideate']);
  });

  it('does not propagate the implying mode SUBJECT to the modes it implies', async () => {
    await enterGoal();
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')!.subject).toBe('g-1');
    expect(rows.find((r) => r.mode === 'auto')!.subject).toBeNull();
  });

  it('does not forge owner-directed provenance on implied rows', async () => {
    await enterGoal({ ownerDirected: true });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')!.ownerDirected).toBe(true);
    expect(rows.find((r) => r.mode === 'auto')!.ownerDirected).toBe(false);
    expect(rows.find((r) => r.mode === 'ideate')!.ownerDirected).toBe(false);
    const peerClear = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'auto', enabled: false, reason: 'peer clears', setBy: PEER, sql: m.sql });
    expect(peerClear).toMatchObject({ ok: true, stickyConflict: undefined });
  });

  it('a mode with no implications reports none (no empty `implied` noise)', async () => {
    const res = await setMode({ workspaceId: WS, ownerId: ME, modeId: 'grade', enabled: true, reason: 'watch the gate', setBy: ME, sql: m.sql });
    expect(res.implied).toBeUndefined();
  });

  /**
   * A cascade write that fails must degrade LOUDLY. Silence is the half-applied
   * state this whole mechanism exists to abolish: the agent would be in GOAL,
   * be treated by every guard as autonomous, and hold no autonomy row.
   */
  it('reports a failed implied write instead of swallowing it — and never fails the applied primary', async () => {
    let hits = 0;
    const failing = ((first: unknown, ...vals: unknown[]) => {
      const text = Array.isArray(first) && 'raw' in (first as object) ? (first as string[]).join(' ') : '';
      if (text.includes('DO NOTHING') && ++hits === 1) return Promise.reject(new Error('deadlock detected'));
      return (m.sql as unknown as (f: unknown, ...v: unknown[]) => unknown)(first, ...vals);
    }) as unknown as Sql;
    const res = await setMode({
      workspaceId: WS, ownerId: ME, modeId: 'goal', enabled: true,
      reason: 'owns goal g-1', setBy: ME, subject: 'g-1', sql: failing,
    });
    expect(res.ok).toBe(true); // the primary landed and is NOT rolled back
    expect(res.implied).toEqual([
      { mode: 'auto', status: 'failed', error: 'deadlock detected' },
      { mode: 'ideate', status: 'set' },
    ]);
  });
});

/**
 * WI-37856 — the RECONCILE, over the STORED population.
 *
 * WHY THIS SUITE EXISTS AND WHY THE EXISTING ONES DID NOT CATCH THE BUG: every
 * cascade test above drives `setMode`, i.e. the WRITE path. The write path was
 * never broken. The defect lived in rows written BEFORE the mode declared its
 * implications — a population no write-path test constructs, which is why 83
 * green tests coexisted with three live agents whose mode set the contract says
 * is impossible. A guard that can only see writes cannot see this class, so the
 * property under test here is deliberately stated over stored ROWS.
 */
describe('reconcileImpliedModes (WI-37856) — repairs the stored population, not the write path', () => {
  let m: ReturnType<typeof mockSql>;
  beforeEach(() => { m = mockSql(); });

  const axisOf = (id: string) => axisKeyFor(modeById(id)!);

  /**
   * Seed a row exactly as it existed before its mode declared implications:
   * straight into the table, no cascade. `setMode` can NO LONGER produce this
   * shape — which is precisely why the gap outlived a green write-path suite,
   * and why seeding directly is the honest fixture rather than a shortcut.
   */
  const seedPreCascade = (mode: string, o?: { ownerDirected?: boolean; subject?: string | null }) => {
    m.modes.set(`${WS}|${ME}|${axisOf(mode)}`, {
      workspace_id: WS, owner_id: ME, axis_key: axisOf(mode), mode,
      reason: 'written before the implication existed', set_by: ME,
      owner_directed: o?.ownerDirected ?? false,
      set_at: '2026-08-10T07:05:19Z', subject: o?.subject ?? null,
    });
  };

  it('fills the modes a pre-existing GOAL row never got — and the BEFORE state proves the fixture was really broken', async () => {
    seedPreCascade('goal', { subject: 'g-cute-bears' });

    // THE FALSIFIER. Without this half, the assertions below would pass just as
    // happily against a fixture that had been complete all along.
    const before = (await getModes(WS, ME, m.sql)).map((r) => r.mode).sort();
    expect(before).toEqual(['goal']);

    const out = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(out).toEqual([{ mode: 'auto', status: 'set' }, { mode: 'ideate', status: 'set' }]);

    const after = (await getModes(WS, ME, m.sql)).map((r) => r.mode).sort();
    expect(after).toEqual(['auto', 'goal', 'ideate']);
  });

  it('stamps backfilled rows as system-authored, and leaves the agent-authored row untouched', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const by = Object.fromEntries((await getModes(WS, ME, m.sql)).map((r) => [r.mode, r.setBy]));
    /* Grading turns on this: goal-mode-e2e's `mode-and-subject-integrity` reads
       these rows, and a backfilled row credited to the agent would read as
       compliance the agent never performed. */
    expect(by.auto).toBe(RECONCILE_SET_BY);
    expect(by.ideate).toBe(RECONCILE_SET_BY);
    expect(by.goal).toBe(ME); // untouched — the reconcile only ever ADDS
  });

  it('does not forge owner-directed provenance when reconciling implied rows', async () => {
    seedPreCascade('goal', { subject: 'g-1', ownerDirected: true });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const rows = await getModes(WS, ME, m.sql);
    expect(rows.find((r) => r.mode === 'goal')?.ownerDirected).toBe(true);
    expect(rows.find((r) => r.mode === 'auto')?.ownerDirected).toBe(false);
    expect(rows.find((r) => r.mode === 'ideate')?.ownerDirected).toBe(false);
  });

  it('is idempotent — a second pass writes nothing and audits nothing (safe to call on every bootstrap)', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    const auditsAfterFirst = m.changes.length;

    const second = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(second).toEqual([{ mode: 'auto', status: 'already-on' }, { mode: 'ideate', status: 'already-on' }]);
    expect(m.changes.length).toBe(auditsAfterFirst); // no second audit row
    expect((await getModes(WS, ME, m.sql)).length).toBe(3);
  });

  it('never displaces a deliberately-chosen posture — cold-auto already satisfies "implies auto"', async () => {
    seedPreCascade('goal', { subject: 'g-1' });
    seedPreCascade('cold-auto');

    const out = await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql });
    expect(out).toContainEqual({ mode: 'auto', status: 'axis-held', by: 'cold-auto' });

    const rows = await getModes(WS, ME, m.sql);
    /* The autonomy axis must still hold cold-auto. Downgrading it to plain
       `auto` would satisfy the letter of "implies auto" while silently undoing
       a choice someone made on purpose. */
    expect(rows.find((r) => r.axisKey === axisOf('cold-auto'))?.mode).toBe('cold-auto');
    expect(rows.map((r) => r.mode).sort()).toEqual(['cold-auto', 'goal', 'ideate']);
  });

  it('does nothing for an agent whose modes imply nothing, and nothing for an agent with no modes at all', async () => {
    expect(await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql })).toEqual([]);
    seedPreCascade('test'); // an overlay that deliberately implies nothing
    expect(await reconcileImpliedModes({ workspaceId: WS, ownerId: ME, sql: m.sql })).toEqual([]);
    expect(m.changes.length).toBe(0);
  });
});
