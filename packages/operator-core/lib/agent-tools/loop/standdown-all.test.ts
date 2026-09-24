/**
 * standdown-all.test.ts — loop:standdown-all (EI-22138154596110669).
 *
 * Mocks getOrgPg/workspace + the control harness (separately covered elsewhere) + sync-sse,
 * so no PG. Same shape as routines/group-set.test.ts, whose runControlMutation fake this
 * mirrors exactly (capturePrev -> [dryRun short-circuit | apply -> verify]).
 *
 * Asserts: role gate · workspace-wide scope by default, fleet-scoped when `fleetSlug` is
 * given (never both in the same WHERE) · every stand-down pause is stamped with the
 * standdownAll marker, generation id, and a FINITE expiresAtMs · resume clears only matching
 * stand-down markers and releases the grading hold ·
 * the loud "captured zero active candidates" warning fires on a real, zero-touched apply
 * (and ONLY then — never on dryRun, never when something was actually paused) · dryRun does
 * not apply · a partial verify surfaces ok:false.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/standdown-all.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELEASE_PAUSE_TTL_MS, LOOP_STANDDOWN_MARKER, listLoopStanddownOwners } from '../../harness/routines/release-pause-ttl';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

const standdownAllTool = (await import('./standdown-all')).default;

// standdown-all returns the canonical { data } shape (definetool-token-optimization P-003
// migration) — a direct .handler() call (bypassing the wire-encoding path) gets the raw
// { data } object, not a { content } envelope.
type Out = { data: Record<string, unknown> };
const body = (o: unknown) => (o as Out).data;

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);

const ACTIVE_ROWS = [
  { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: true, pause: null, last_pause: null },
  { install_slug: 'papercusp', name: 'loop-su-bob', target_owner_id: 'su-bob', active: true, pause: null, last_pause: null },
];

const STANDDOWN_GENERATION = 'generation-1';
const PAUSED_ROWS = [
  {
    install_slug: 'papercusp',
    name: 'loop-su-alice',
    target_owner_id: 'su-alice',
    active: false,
    pause: {
      reason: 'coordinated host restart',
      pausedBy: 'role:operator',
      pausedAtMs: NOW - 1000,
      [LOOP_STANDDOWN_MARKER]: true,
      standdownGeneration: STANDDOWN_GENERATION,
      expiresAtMs: NOW + DEFAULT_RELEASE_PAUSE_TTL_MS,
    },
    last_pause: null,
  },
  {
    install_slug: 'papercusp',
    name: 'loop-su-bob',
    target_owner_id: 'su-bob',
    active: false,
    pause: {
      reason: 'coordinated host restart',
      pausedBy: 'role:operator',
      pausedAtMs: NOW - 1000,
      [LOOP_STANDDOWN_MARKER]: true,
      standdownGeneration: STANDDOWN_GENERATION,
      expiresAtMs: NOW + DEFAULT_RELEASE_PAUSE_TTL_MS,
    },
    last_pause: { reason: 'previous single-loop pause', pausedAtMs: NOW - 5000 },
  },
];

function withCurrentStanddownGeneration(rows: Array<Record<string, unknown>>) {
  const updateCall = sqlMock.mock.calls.find((call) =>
    call.some((arg) => typeof arg === 'string' && arg.includes('"standdownGeneration"')),
  );
  const stampJson = updateCall?.find((arg) => typeof arg === 'string' && arg.includes('"standdownGeneration"'));
  const stampText = typeof stampJson === 'string' ? stampJson : null;
  const generation = stampText ? (JSON.parse(stampText) as { standdownGeneration: string }).standdownGeneration : null;
  return rows.map((row) => ({ ...row, standdown_generation: generation }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

describe('loop:standdown-all', () => {
  it('rejects a role without operator-config write authority', async () => {
    await expect(
      standdownAllTool.handler({ reason: 'host restart' } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('workspace-wide (no fleetSlug): scopes to every active loop-su-% row, never a fleet/coord_presence join', async () => {
    sqlMock
      .mockResolvedValueOnce(ACTIVE_ROWS) // capturePrev
      .mockResolvedValueOnce(ACTIVE_ROWS) // apply's re-read
      .mockResolvedValueOnce([]) // the bulk pause UPDATE
      .mockImplementationOnce(async () => withCurrentStanddownGeneration([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: false, standdown: true },
        { install_slug: 'papercusp', name: 'loop-su-bob', target_owner_id: 'su-bob', active: false, standdown: true },
      ])); // verify SELECT

    const b = body(
      await standdownAllTool.handler({ reason: 'coordinated host restart' } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, scope: 'workspace', applied: true, pausedCount: 2, verify: { ok: true } });
    expect(b.targets).toEqual([
      { ownerId: 'su-alice', routineName: 'loop-su-alice', harness: 'papercusp' },
      { ownerId: 'su-bob', routineName: 'loop-su-bob', harness: 'papercusp' },
    ]);

    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    const scanCalls = calls.filter((c) => c.includes('FROM harness_shared.routines') && c.includes('active = true'));
    expect(scanCalls.length).toBeGreaterThan(0);
    for (const c of scanCalls) expect(c).not.toContain('coord_presence');

    const update = calls.find((c) => c.includes('UPDATE harness_shared.routines') && c.includes('SET active = false'));
    expect(update).toBeDefined();
    expect(update).not.toContain('coord_presence');
    // stamped standdownAll marker + a FINITE default-TTL expiresAtMs, never an open-ended hold
    expect(update).toContain(`"${LOOP_STANDDOWN_MARKER}":true`);
    expect(update).toContain(`"expiresAtMs":${NOW + DEFAULT_RELEASE_PAUSE_TTL_MS}`);
    expect(update).toContain('"reason":"coordinated host restart"');
    expect(b.standdownGeneration).toMatch(/^[0-9a-f-]{36}$/i);
    expect(update).toContain(`"standdownGeneration":"${String(b.standdownGeneration)}"`);
  });

  it('workspace-wide resume clears only standdownAll markers and releases the grading hold', async () => {
    sqlMock
      .mockResolvedValueOnce(PAUSED_ROWS) // capturePrev
      .mockResolvedValueOnce(PAUSED_ROWS) // apply's re-read
      .mockResolvedValueOnce(PAUSED_ROWS.map(({ install_slug, name }) => ({ install_slug, name }))) // exact-marker resume UPDATE
      .mockResolvedValueOnce([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: true, standdown: null },
        { install_slug: 'papercusp', name: 'loop-su-bob', target_owner_id: 'su-bob', active: true, standdown: null },
      ]); // verify SELECT

    const b = body(await standdownAllTool.handler({ action: 'resume', reason: 'owner-directed resume' } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, action: 'resume', applied: true, pausedCount: 0, resumedCount: 2, verify: { ok: true } });

    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    const read = calls.find((c) => c.includes('FROM harness_shared.routines r') && c.includes(LOOP_STANDDOWN_MARKER));
    expect(read).toContain("r.metadata -> 'pause' ->> 'fleetSlug' IS NULL");
    const updateCall = sqlMock.mock.calls.find((call) =>
      Array.isArray(call[0]) && (call[0] as string[]).join('').includes('UPDATE harness_shared.routines AS routine'),
    );
    const updateSql = (updateCall?.[0] as string[] | undefined)?.join('') ?? '';
    const updateArgs = updateCall?.slice(1) ?? [];
    const update = calls.find((c) => c.includes('UPDATE harness_shared.routines AS routine'));
    expect(update).toContain('SET active = true');
    expect(update).toContain('jsonb_to_recordset');
    expect(update).toContain("routine.metadata -> 'pause' = targets.pause");
    expect(updateSql).toContain("routine.metadata -> 'pause' ->> ");
    expect(updateSql).toContain("= 'true'");
    expect(updateArgs).toContain(LOOP_STANDDOWN_MARKER);
    expect(update).toContain("'{lastPause}'");

    const heldOwners = await listLoopStanddownOwners(sqlMock as never, {
      workspaceId: 'default',
      nowMs: NOW,
      workspaceWideOnly: true,
    });
    expect(heldOwners).toEqual(new Set());
  });

  it('resumes only the requested standdown generation when one is supplied', async () => {
    sqlMock
      .mockResolvedValueOnce([PAUSED_ROWS[0]]) // capturePrev
      .mockResolvedValueOnce([PAUSED_ROWS[0]]) // apply's re-read
      .mockResolvedValueOnce([{ install_slug: 'papercusp', name: 'loop-su-alice' }]) // update
      .mockResolvedValueOnce([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: true, standdown: null },
      ]); // verify SELECT

    const b = body(
      await standdownAllTool.handler(
        { action: 'resume', reason: 'resume one generation', standdownGeneration: STANDDOWN_GENERATION } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ action: 'resume', resumedCount: 1, verify: { ok: true } });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    const read = calls.find((c) => c.includes('FROM harness_shared.routines r') && c.includes(LOOP_STANDDOWN_MARKER));
    expect(read).toContain("r.metadata -> 'pause' ->> 'standdownGeneration' =");
    expect(read).toContain(STANDDOWN_GENERATION);
  });

  it('fleetSlug: scopes both capture and apply to that fleet\'s CURRENT members (coord_presence), never the whole workspace', async () => {
    sqlMock
      .mockResolvedValueOnce([ACTIVE_ROWS[0]]) // capturePrev, fleet-scoped
      .mockResolvedValueOnce([ACTIVE_ROWS[0]]) // apply's re-read
      .mockResolvedValueOnce([]) // UPDATE
      .mockImplementationOnce(async () => withCurrentStanddownGeneration([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: false, standdown: true },
      ])); // verify

    const b = body(
      await standdownAllTool.handler(
        { reason: 'fleet-scoped hold', fleetSlug: 'ei217419-current-head-20260830-1141' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, scope: 'fleet:ei217419-current-head-20260830-1141', pausedCount: 1 });

    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    const scanCalls = calls.filter((c) => c.includes('FROM harness_shared.routines') && c.includes('active = true'));
    for (const c of scanCalls) {
      expect(c).toContain('coord_presence');
      expect(c).toContain('ei217419-current-head-20260830-1141');
    }
    const update = calls.find((c) => c.includes('UPDATE harness_shared.routines') && c.includes('SET active = false'));
    expect(update).toContain('"fleetSlug":"ei217419-current-head-20260830-1141"');
  });

  it('an explicit pauseTtlHours overrides the default TTL in the stamped expiresAtMs', async () => {
    sqlMock
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => withCurrentStanddownGeneration([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: false, standdown: true },
        { install_slug: 'papercusp', name: 'loop-su-bob', target_owner_id: 'su-bob', active: false, standdown: true },
      ]));
    await standdownAllTool.handler({ reason: 'short hold', pauseTtlHours: 0.5 } as never, { role: 'operator' } as never);
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    const update = calls.find((c) => c.includes('UPDATE harness_shared.routines') && c.includes('SET active = false'));
    expect(update).toContain(`"expiresAtMs":${NOW + 0.5 * 3_600_000}`);
  });

  it('a real apply that captures ZERO active candidates is loudly warned, never a silent success', async () => {
    sqlMock.mockResolvedValueOnce([]); // capturePrev: nothing active — apply() short-circuits, never re-reads/updates/verifies
    const b = body(await standdownAllTool.handler({ reason: 'nothing to pause' } as never, { role: 'operator' } as never));
    expect(b).toMatchObject({ ok: true, applied: true, pausedCount: 0 });
    expect(b.warning).toMatch(/NOTHING was paused/i);
  });

  it('dryRun previews without pausing anything or warning', async () => {
    sqlMock.mockResolvedValueOnce(ACTIVE_ROWS); // capturePrev only — apply/verify never run under dryRun
    const b = body(
      await standdownAllTool.handler({ reason: 'preview', dryRun: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, dryRun: true, applied: false, pausedCount: 0 });
    expect(b.warning).toBeUndefined();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces verify:{ok:false} when a targeted loop is not actually paused+stamped after the write', async () => {
    sqlMock
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce([])
      // one of the two rows raced back to active — verify must catch it, not just trust the UPDATE
      .mockResolvedValueOnce([
        { install_slug: 'papercusp', name: 'loop-su-alice', target_owner_id: 'su-alice', active: false, standdown: true },
        { install_slug: 'papercusp', name: 'loop-su-bob', target_owner_id: 'su-bob', active: true, standdown: null },
      ]);
    const b = body(await standdownAllTool.handler({ reason: 'race check' } as never, { role: 'operator' } as never));
    expect(b.verify).toMatchObject({ ok: false, detail: expect.stringContaining('not every targeted loop') });
  });
// EI-22818006456104074: the workspace-wide scan used to admit NULL-owner system reschedule routines
  // (service-health, stale-claim-sweep, …) into prev; the owner-keyed UPDATE/verify could never match
  // them (`= ANY()` never matches NULL), verify failed, runControlMutation auto-reverted, and the tool
  // returned ok:true applied:false pausedCount:0 — the system-wide pause lever silently no-oped.
  it("EI-22818006456104074: every scan confines itself to loop-su-% rows with a NON-NULL owner", async () => {
    sqlMock
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => withCurrentStanddownGeneration([
        { install_slug: "papercusp", name: "loop-su-alice", target_owner_id: "su-alice", active: false, standdown: true },
        { install_slug: "papercusp", name: "loop-su-bob", target_owner_id: "su-bob", active: false, standdown: true },
      ]));
    const b = body(await standdownAllTool.handler({ reason: "scope check" } as never, { role: "operator" } as never));
    expect(b).toMatchObject({ ok: true, applied: true, pausedCount: 2 });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(" "));
    const scanCalls = calls.filter((c) => c.includes("FROM harness_shared.routines") && c.includes("active = true"));
    expect(scanCalls.length).toBeGreaterThan(0);
    for (const c of scanCalls) {
      expect(c).toContain("name LIKE 'loop-su-%'");
      expect(c).toContain("target_owner_id IS NOT NULL");
    }
    const update = calls.find((c) => c.includes("UPDATE harness_shared.routines") && c.includes("SET active = false"));
    expect(update).toContain("name LIKE 'loop-su-%'");
  });

  it("EI-22818006456104074: verify is keyed by (install_slug,name), so an unrelated active row for the same owner does not fail it", async () => {
    sqlMock
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce(ACTIVE_ROWS)
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => withCurrentStanddownGeneration([
        { install_slug: "papercusp", name: "loop-su-alice", target_owner_id: "su-alice", active: false, standdown: true },
        // a stale sibling row for the same owner, NOT a target — an owner-keyed verify would pick this one up and revert
        { install_slug: "papercusp", name: "loop-su-alice-old", target_owner_id: "su-alice", active: true, standdown: null },
        { install_slug: "papercusp", name: "loop-su-bob", target_owner_id: "su-bob", active: false, standdown: true },
      ]));
    const b = body(await standdownAllTool.handler({ reason: "row-key check" } as never, { role: "operator" } as never));
    expect(b).toMatchObject({ ok: true, applied: true, pausedCount: 2, verify: { ok: true } });
  });
});
