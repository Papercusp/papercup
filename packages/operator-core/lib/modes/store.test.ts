/**
 * Mode store semantics (modes-and-intake-ux-2026-07-05 P-006):
 * axis auto-switch (D-006), owner-sticky refusal (D-003), clear/no-op paths,
 * and the append-only audit — over a mock sql seam (no PG).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { setMode, getModes, getModesForOwners } from './store';
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
      const [ws, owner, axis, mode, reason, setBy, ownerDirected] = vals as string[];
      modes.set(key(ws, owner, axis), {
        workspace_id: ws, owner_id: owner, axis_key: axis, mode,
        reason, set_by: setBy, owner_directed: Boolean(ownerDirected), set_at: '2026-07-05T00:00:00Z',
      });
      return Promise.resolve([]);
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
  it('covers the five official modes with correct axes (owner correction: ideate/drain are stackable overlays)', () => {
    expect(MODES.map((m) => m.id).sort()).toEqual(['auto', 'cold-auto', 'drain', 'grade', 'ideate']);
    expect(modeById('auto')?.axis).toBe('autonomy');
    expect(modeById('cold-auto')?.axis).toBe('autonomy');
    expect(modeById('ideate')?.axis).toBe('overlay');
    expect(modeById('drain')?.axis).toBe('overlay');
    expect(modeById('grade')?.axis).toBe('overlay');
  });

  it('axis keys: the autonomy family shares a key; each overlay gets its own', () => {
    expect(axisKeyFor(modeById('auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('cold-auto')!)).toBe('autonomy');
    expect(axisKeyFor(modeById('ideate')!)).toBe('overlay:ideate');
    expect(axisKeyFor(modeById('drain')!)).toBe('overlay:drain');
    expect(axisKeyFor(modeById('grade')!)).toBe('overlay:grade');
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
    expect(rows.map((r) => r.mode).sort()).toEqual(['drain', 'ideate']);
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
