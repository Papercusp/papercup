/**
 * routines.test.ts — routines:list + routines:set (live-configurability-audit P-002).
 *
 * Mocks getOrgPg/workspace/home-harness/cron + the control harness (separately covered), so no PG.
 * Asserts: list maps rows (cron from trigger_config, iso timestamps) · set is operator/architect-
 * gated · set requires cron|active · an invalid cron is rejected BEFORE any DB touch · pause
 * (active:false) runs through the harness · dryRun does not apply.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/routines/routines.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Declare the mock's PARAMETERS, not just its return: `vi.fn(async () => …)` is a
// zero-arg signature, so `sqlMock.mock.calls` types as `[][]` and `.flat()` collapses
// to `never[]`. Every `typeof v === 'string'` guard below then narrows `never` (which
// has no properties) and TS rejects `.startsWith` / `.includes` — 5 errors that had
// nothing to do with the assertions themselves. Typing the rest args as `unknown[]`
// gives `.flat()` an `unknown[]`, which those guards narrow correctly. (WI-3616 drive-by:
// these 5 were the entire operator-core typecheck overage, 228 vs baseline 224.)
const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../harness/operator-home-harness', async (orig) => ({ ...(await orig<Record<string, unknown>>()), operatorHomeHarnessSlug: () => 'home-harness' }));
vi.mock('../../harness/routines/cron', async (orig) => ({ ...(await orig<Record<string, unknown>>()), computeNextFireAt: vi.fn(() => new Date('2030-01-01T00:00:00Z')) }));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import { computeNextFireAt } from '../../harness/routines/cron';
const cronM = vi.mocked(computeNextFireAt);

const listTool = (await import('./list')).default;
const setTool = (await import('./set')).default;

type Out = { content?: { text: string }[]; data?: unknown };
// routines:list returns a {data} envelope (context-trimming-tiers P-023);
// routines:set still self-serializes content[] — handle both.
const body = (o: unknown) => {
  const out = o as Out;
  return out.data !== undefined ? out.data : JSON.parse(out.content![0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  cronM.mockReturnValue(new Date('2030-01-01T00:00:00Z'));
  sqlMock.mockResolvedValue([]);
});

describe('routines:list', () => {
  it('maps rows (cron from trigger_config, iso timestamps)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */10 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date('2030-01-01T00:00:00Z'),
        last_fired_at: null,
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.count).toBe(1);
    expect(b.routines[0]).toMatchObject({ name: 'git-sync', cron: '0 */10 * * * *', active: true, lastFiredAt: null });
  });

  /*
   * EI-19336000265007219 — a DELIBERATE PAUSE must be distinguishable from a STALL.
   *
   * routines:set has recorded metadata.pause { reason, pausedBy, pausedAtMs } on every
   * pause since EI-18654017982759582, which existed because a routine paused during an
   * incident had TWICE sat silently paused for days: "nothing durable said WHO paused
   * it or WHY, so a responder could not tell a stuck bug from a deliberate hold".
   *
   * But this tool never SELECTed `metadata`, so the responder that record was written
   * for still saw a bare active:false. It happened a third time — improvement-implement,
   * paused 2026-07-28T03:40Z via the Agents pane, noticed five days later and filed as a
   * suspected stall by an agent who correctly hedged "may be an intentional pause ... not
   * obviously documented anywhere I found". The answer was one column over in the row
   * they had already queried.
   *
   * These tests pin the READ side, because a durable record nobody reads is just a
   * quieter silence.
   */
  it('surfaces the deliberate-pause record on a paused routine (EI-19336000265007219)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'improvement-implement',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */30 * * * *' },
        target_role: 'system:improvement-implement',
        active: false,
        next_fire_at: null,
        last_fired_at: new Date('2026-07-28T03:30:01Z'),
        metadata: {
          pause: { reason: 'Paused via the Agents pane', pausedBy: 'loopback', pausedAtMs: 1785210000297 },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].paused).toEqual({
      reason: 'Paused via the Agents pane',
      by: 'loopback',
      at: '2026-07-28T03:40:00.297Z',
    });
  });

  /**
   * P-002 (sql-escape-tool-routing-2026-08-12). The sibling of the pause tests
   * above, and the same defect one field family over: this tool already SELECTs
   * `metadata`, so 112 distinct agents hand-writing
   * `SELECT metadata->'gate_health' FROM harness_shared.routines` (722 calls in
   * 14 days — the largest raw-SQL cluster in the audit) were querying a row it
   * had already fetched and thrown away.
   */
  it('surfaces gate_health on the green-checkpoint routine (P-002 — the 112-agent cluster)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:green-checkpoint',
        active: true,
        next_fire_at: new Date('2026-08-12T17:00:00Z'),
        last_fired_at: new Date('2026-08-12T16:00:00Z'),
        metadata: {
          gate_health: { inFlightRetriage: null, observedCandidate: 'abc123', consecutiveReds: 3 },
          last_status: 'red',
          consecutive_error_ticks: 2,
          fire_count: 411,
          pause: null,
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      gate_health: { observedCandidate: 'abc123', consecutiveReds: 3 },
      last_status: 'red',
      consecutive_error_ticks: 2,
      fire_count: 411,
    });
  });

  it('reports health:null for a routine carrying no operational metadata — the field stays cheap', async () => {
    // The projection must not turn every ordinary row into a bag of nulls: the
    // trimmed payload is what an agent sees by default, and this tool lists
    // hundreds of rows.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'plain',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:plain',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        metadata: { armed_at: null, some_unrelated_key: 'x' },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toBeNull();
  });

  it('reports paused:null for an inactive routine with NO pause record — the case that IS worth investigating', async () => {
    // The distinction is the whole point: this row and the one above are both
    // active:false, and only the pause record tells them apart.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'never-armed',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:never-armed',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {},
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0]).toMatchObject({ active: false, paused: null });
  });

  it('tolerates a malformed/partial pause record rather than throwing', async () => {
    // Defensive: metadata is free-form jsonb written by several call sites, and a
    // read surface that throws on a surprise shape is worse than one that degrades.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'odd',
        trigger_kind: 'cron',
        trigger_config: {},
        target_role: 'system:odd',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        metadata: { pause: { reason: 42, pausedAtMs: 'not-a-number' } },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].paused).toEqual({ reason: null, by: null, at: null });
  });

  it('KEEPS `paused` in the trimmed projection — dropping it would reinstate the bug by default', async () => {
    // trimmed is the tier an agent sees unless it asks for full, so this is where the
    // fix actually has to land. Asserted explicitly so a future trim-slimming edit
    // cannot quietly remove it.
    const trimmed = listTool.shape!.trimmed!({
      count: 1,
      routines: [
        {
          installSlug: 'papercusp',
          name: 'improvement-implement',
          cron: '0 */30 * * * *',
          active: false,
          nextFireAt: null,
          group: null,
          paused: { reason: 'Paused via the Agents pane', by: 'loopback', at: '2026-07-28T03:40:00.297Z' },
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };
    expect(trimmed.routines[0].paused).toMatchObject({ reason: 'Paused via the Agents pane' });
  });

  // EI-7242: `q` was previously not a recognized arg at all — zod silently
  // stripped it and the query ran unfiltered (the whole catalog came back).
  it('accepts a `q` free-text filter and passes it through as an ILIKE pattern (EI-7242)', async () => {
    await listTool.handler({ q: 'git-sync' } as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs).toContain('%git-sync%');
  });

  it('omits the `q` filter (passes null) when not provided — no accidental narrowing', async () => {
    await listTool.handler({} as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs.some((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'))).toBe(false);
  });

  it('passes through group_slug as `group` on each row', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */10 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        group_slug: 'git-sync',
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0]).toMatchObject({ name: 'git-sync', group: 'git-sync' });
  });

  // WI-5018: rollup:true switches to the per-group aggregate query — a distinct SELECT
  // shape (group_slug/description/steward/review_cadence/last_reviewed_at + counts), not
  // the raw routines rows.
  it('rollup:true returns a per-group aggregate with reviewDue computed from review_cadence + last_reviewed_at', async () => {
    const overdue = new Date(Date.now() - 100 * 86_400_000); // 100 days ago, cadence 90d -> due
    sqlMock.mockResolvedValue([
      {
        group_slug: 'health',
        description: 'Cleanup + integrity sweeps.',
        steward: null,
        review_cadence: '90d',
        last_reviewed_at: overdue,
        count: '12',
        active_count: '10',
        most_recent_fire: null,
      },
    ]);
    const b = body(await listTool.handler({ rollup: true } as never, { role: 'su' } as never));
    expect(b.rollup).toHaveLength(1);
    expect(b.rollup[0]).toMatchObject({
      group: 'health',
      count: 12,
      activeCount: 10,
      inactiveCount: 2,
      reviewDue: true,
    });
  });

  it('group:"" (ungrouped-only) passes groupFilterActive=true and groupIsNull=true to the query, distinctly from a normal group filter', async () => {
    await listTool.handler({ group: '' } as never, { role: 'su' } as never);
    const emptyGroupArgs = sqlMock.mock.calls.flat();
    sqlMock.mockClear();
    await listTool.handler({ group: 'health' } as never, { role: 'su' } as never);
    const namedGroupArgs = sqlMock.mock.calls.flat();
    // Both narrow (groupFilterActive:true in both), but group:'' passes groupIsNull:true
    // while group:'health' passes groupIsNull:false and the literal slug 'health' as groupVal.
    expect(emptyGroupArgs.filter((v) => v === true).length).toBeGreaterThan(
      namedGroupArgs.filter((v) => v === true).length,
    );
    expect(namedGroupArgs).toContain('health');
  });
});

describe('routines:set', () => {
  it('rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      setTool.handler({ name: 'git-sync', active: false } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('accepts the queen (operator-equivalent, EI-2204)', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, reason: 'test pause' } as never,
        { role: 'mug' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
  });

  it('requires cron, active, triggerConfig, payloadTemplate, or group', async () => {
    await expect(
      setTool.handler({ name: 'git-sync' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires cron, active, triggerConfig, payloadTemplate, and\/or group/i);
  });

  // WI-5018: assigning a group auto-creates it (blank metadata) in routine_groups —
  // the FK requires the row to exist; routines:group-set is where a steward fills it in.
  it('assigns a group — auto-creates the group row (INSERT ... ON CONFLICT DO NOTHING) then writes group_slug', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, group_slug: null }]);
    const b = body(
      await setTool.handler({ name: 'git-sync', group: 'git-sync' } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    expect(calls.some((c) => c.includes('routine_groups') && c.includes('ON CONFLICT'))).toBe(true);
    expect(calls.some((c) => c.includes('group_slug') && c.includes('git-sync'))).toBe(true);
  });

  it('clears a group with group:null (ungroup) — no auto-create INSERT fires', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, group_slug: 'health' }]);
    const b = body(
      await setTool.handler({ name: 'git-sync', group: null } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    expect(calls.some((c) => c.includes('routine_groups') && c.includes('ON CONFLICT'))).toBe(false);
  });

  // WI-4482: the scout singleton's run knobs live in payload_template, NOT trigger_config —
  // so retuning budget.maxIdeators had no sanctioned path and required the raw
  // `UPDATE harness_shared.routines` the playbook forbids.
  it('DEEP-merges a payload_template patch — retunes one nested knob without clobbering its siblings', async () => {
    // The live scout singleton payload shape: budget + models + cadence under `payload`.
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */30 * * * *' },
        payload_template: {
          blueprintId: 'scout',
          cycleTimeoutMs: 600000,
          payload: {
            budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 1 },
            models: { ideator: 'chatgpt:5.5', critic: 'chatgpt:5.5' },
            cadence: { idleThreshold: 0.5, frictionThreshold: 3 },
          },
        },
        active: true,
        next_fire_at: null,
      },
    ]);
    const b = body(
      await setTool.handler(
        {
          name: 'bp-singleton-scout-0',
          installSlug: '@singleton',
          payloadTemplate: { payload: { budget: { maxIdeators: 4, maxCriticsPerIdea: 2 } } },
        } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls
      .flat()
      .find((v) => typeof v === 'string' && v.includes('maxIdeators')) as string | undefined;
    expect(wrote).toBeDefined();
    const written = JSON.parse(wrote!);
    // The two patched keys applied...
    expect(written.payload.budget.maxIdeators).toBe(4);
    expect(written.payload.budget.maxCriticsPerIdea).toBe(2);
    // ...the UNPATCHED sibling key inside the SAME nested object survived...
    expect(written.payload.budget.maxCostUsd).toBe(1);
    // ...and the sibling OBJECTS survived. A shallow Object.assign of { payload: {...} } would
    // have replaced `payload` wholesale and silently dropped models + cadence — turning a
    // one-key retune into a config wipe. This assertion is the whole reason the merge is deep.
    expect(written.payload.models).toEqual({ ideator: 'chatgpt:5.5', critic: 'chatgpt:5.5' });
    expect(written.payload.cadence).toEqual({ idleThreshold: 0.5, frictionThreshold: 3 });
    expect(written.blueprintId).toBe('scout');
    expect(written.cycleTimeoutMs).toBe(600000);
  });

  it('payload_template arrays and scalars REPLACE (a patched list is the new list, not a merge)', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: {}, payload_template: { payload: { lenses: ['a', 'b', 'c'], n: 1 } }, active: true, next_fire_at: null },
    ]);
    await setTool.handler(
      { name: 'r', payloadTemplate: { payload: { lenses: ['z'], n: 9 } } } as never,
      { role: 'operator' } as never,
    );
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('lenses')) as string;
    const written = JSON.parse(wrote);
    expect(written.payload.lenses).toEqual(['z']);
    expect(written.payload.n).toBe(9);
  });

  it('patches trigger_config (P-017) — merges the patch, preserves cron, ignores a cron key in the patch', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *', throttle_min: 8 }, active: true, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'claim-discipline', triggerConfig: { throttle_min: 4, cron: 'EVIL' } } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    // The UPDATE wrote the merged trigger_config: the caps patch (throttle_min:4) applied, cron preserved
    // (0 */10) — the `cron: 'EVIL'` key in the patch was ignored (cron only via the validated arg).
    const wrote = sqlMock.mock.calls.some((c) =>
      c.some((v) => typeof v === 'string' && v.includes('"throttle_min":4') && v.includes('"cron":"0 */10') && !v.includes('EVIL')),
    );
    expect(wrote).toBe(true);
  });

  it('rejects an invalid cron before any DB touch', async () => {
    cronM.mockReturnValue(null);
    await expect(
      setTool.handler({ name: 'git-sync', cron: 'nope' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/invalid cron/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('pauses a routine (active:false) through the harness', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, reason: 'manual deploy surgery' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true, routine: 'home-harness/git-sync', verify: { ok: true } });
  });

  it('dryRun does not apply', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, dryRun: true, reason: 'manual deploy surgery' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });

  // EI-18654017982759582: a pause with no recorded reason/owner is exactly how release-trigger
  // silently stayed off for days (twice) — require a reason up front.
  it('rejects active:false with no reason', async () => {
    await expect(
      setTool.handler({ name: 'release-trigger', active: false } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires a `reason`/);
  });

  it('persists metadata.pause { reason, pausedBy, pausedAtMs } on pause, preserving other metadata keys', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, metadata: { gate_health: { lastGreenAt: 123 } } },
    ]);
    const b = body(
      await setTool.handler(
        { name: 'release-trigger', active: false, reason: 'pausing for incident triage' } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toMatchObject({ reason: 'pausing for incident triage', pausedBy: 'su-test-1' });
    expect(typeof written.pause.pausedAtMs).toBe('number');
    // The concurrently-written gate_health key from another writer survives untouched.
    expect(written.gate_health).toEqual({ lastGreenAt: 123 });
  });

  // EI-19370236916382521: the DARK_FLAGS_REVIEW_BY analog for a deliberately-paused
  // always-on learning loop — "re-affirm it explicitly rather than letting this alarm
  // re-fire silently" needs somewhere durable to land.
  it('persists metadata.pause.reviewBy when passed alongside active:false', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 20 6 1 * *' }, active: true, next_fire_at: null, metadata: {} },
    ]);
    const b = body(
      await setTool.handler(
        {
          name: 'bp-singleton-iq-battery-0',
          installSlug: '@singleton',
          active: false,
          reason: 're-affirmed: deliberate owner pause, part of a broader Agents-pane sweep',
          reviewBy: '2026-11-01T00:00:00.000Z',
        } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toMatchObject({
      reason: 're-affirmed: deliberate owner pause, part of a broader Agents-pane sweep',
      pausedBy: 'su-test-1',
      reviewBy: '2026-11-01T00:00:00.000Z',
    });
  });

  it('omits reviewBy from metadata.pause entirely when not passed — a plain pause stays a plain pause', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, metadata: {} },
    ]);
    const b = body(
      await setTool.handler(
        { name: 'release-trigger', active: false, reason: 'pausing for incident triage' } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect('reviewBy' in written.pause).toBe(false);
  });

  it('moves metadata.pause to lastPause on resume (active:true)', async () => {
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */10 * * * *' },
        active: false,
        next_fire_at: null,
        metadata: { pause: { reason: 'r', pausedBy: 'su-x', pausedAtMs: 1 } },
      },
    ]);
    const b = body(
      await setTool.handler({ name: 'release-trigger', active: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('lastPause')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toBeUndefined();
    expect(written.lastPause).toMatchObject({ reason: 'r', pausedBy: 'su-x' });
    expect(typeof written.lastPause.resumedAtMs).toBe('number');
  });
});
