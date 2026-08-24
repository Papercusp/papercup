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
// The live tool barrel installs the built-in cells before any door is dispatched.
// This file imports the door directly, so reproduce that bootstrap explicitly.
import '../cell-registrations-wiring';

// Declare the mock's PARAMETERS, not just its return: `vi.fn(async () => …)` is a
// zero-arg signature, so `sqlMock.mock.calls` types as `[][]` and `.flat()` collapses
// to `never[]`. Every `typeof v === 'string'` guard below then narrows `never` (which
// has no properties) and TS rejects `.startsWith` / `.includes` — 5 errors that had
// nothing to do with the assertions themselves. Typing the rest args as `unknown[]`
// gives `.flat()` an `unknown[]`, which those guards narrow correctly. (WI-3616 drive-by:
// these 5 were the entire operator-core typecheck overage, 228 vs baseline 224.)
const { sqlMock, controlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  controlMock: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../harness/operator-home-harness', async (orig) => ({ ...(await orig<Record<string, unknown>>()), operatorHomeHarnessSlug: () => 'home-harness' }));
vi.mock('../../harness/routines/cron', async (orig) => ({ ...(await orig<Record<string, unknown>>()), computeNextFireAt: vi.fn(() => new Date('2030-01-01T00:00:00Z')) }));
vi.mock('../../gateway-control/control-harness', () => ({ runControlMutation: controlMock }));
vi.mock('../../release-checkpoint-config', () => ({
  readQualificationAdmission: vi.fn(async () => ({ status: 'clear' as const })),
}));
vi.mock('../../release/checkpoint-serializer-authority', () => ({
  readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'none' as const, reason: 'routine-not-paused' as const })),
}));
vi.mock('../../release-checkpoint-launch', () => ({
  checkActiveCheckpointRun: vi.fn(() => ({
    active: false,
    unit: 'papercusp-green-checkpoint',
    systemd: { scope: 'user' as const, argv: [], load_state: 'loaded', known: true, invocation_id: null },
  })),
}));
vi.mock('../../harness/routines/release-actions', () => ({
  resolveIntegrationRoot: vi.fn(() => '/integration-root'),
}));

import { computeNextFireAt } from '../../harness/routines/cron';
import { readQualificationAdmission } from '../../release-checkpoint-config';
import { readCheckpointSerializerAuthority } from '../../release/checkpoint-serializer-authority';
import { checkActiveCheckpointRun } from '../../release-checkpoint-launch';
import { resolveIntegrationRoot } from '../../harness/routines/release-actions';
const cronM = vi.mocked(computeNextFireAt);
const admissionM = vi.mocked(readQualificationAdmission);
const serializerM = vi.mocked(readCheckpointSerializerAuthority);
const activeRunM = vi.mocked(checkActiveCheckpointRun);
const rootM = vi.mocked(resolveIntegrationRoot);

const listModule = await import('./list');
const listTool = listModule.default;
const { attestGateHealth } = listModule;
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
  admissionM.mockResolvedValue({ status: 'clear' });
  serializerM.mockResolvedValue({ status: 'none', reason: 'routine-not-paused' });
  activeRunM.mockReturnValue({
    active: false,
    unit: 'papercusp-green-checkpoint',
    systemd: { scope: 'user', argv: [], load_state: 'loaded', known: true, invocation_id: null },
  });
  rootM.mockReturnValue('/integration-root');
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
          gate_health: {
            inFlightRetriage: null,
            observedAt: Date.parse('2026-08-12T16:00:00.000Z'),
            observedCandidate: 'abc123',
            candidateCommittedAt: Date.parse('2026-08-12T15:30:00.000Z'),
            commitsBehindTip: 4,
            consecutiveReds: 3,
          },
          git_sync_activity: {
            active: true,
            phase: 'post-legs',
            started_at: 1786550000000,
            updated_at: 1786550005000,
            completed_at: null,
            outcome_status: 'synced',
          },
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
      git_sync_activity: { active: true, phase: 'post-legs', outcome_status: 'synced' },
      last_status: 'red',
      consecutive_error_ticks: 2,
      fire_count: 411,
    });
    expect(b.routines[0].health.gate_health.readAttestation).toMatchObject({
      snapshotObservedAt: '2026-08-12T16:00:00.000Z',
      observedCandidate: 'abc123',
      candidateCommittedAt: '2026-08-12T15:30:00.000Z',
      candidateAgeAtObservationMs: 30 * 60_000,
      commitsBehindTip: 4,
    });
    expect(b.routines[0].health.gate_health.readAttestation.snapshotAgeMs).toEqual(expect.any(Number));
    expect(b.routines[0].health.gate_health.readAttestation.snapshotAge).toMatch(/ ago$/);
  });

  it('renders a deterministic read-time age and candidate attestation without rewriting raw fields', () => {
    const observedAt = Date.parse('2026-08-12T16:00:00.000Z');
    const candidateCommittedAt = Date.parse('2026-08-12T15:30:00.000Z');
    const raw = {
      observedAt,
      observedCandidate: 'abc123',
      candidateCommittedAt,
      commitsBehindTip: 4,
      failingTests: ['a.test.ts'],
    };

    const result = attestGateHealth(raw, Date.parse('2026-08-12T17:30:00.000Z')) as Record<string, unknown>;
    expect(result).toMatchObject({ ...raw, failingTests: ['a.test.ts'] });
    expect(result.readAttestation).toEqual({
      snapshotObservedAt: '2026-08-12T16:00:00.000Z',
      snapshotAgeMs: 90 * 60_000,
      snapshotAge: '1h30m ago',
      observedCandidate: 'abc123',
      candidateCommittedAt: '2026-08-12T15:30:00.000Z',
      candidateAgeAtObservationMs: 30 * 60_000,
      commitsBehindTip: 4,
    });
  });

  it('does not invent provenance for a legacy or malformed gate-health blob', () => {
    const result = attestGateHealth(
      { observedAt: 'not-a-timestamp', failingTests: ['a.test.ts'] },
      Date.parse('2026-08-12T17:30:00.000Z'),
    ) as Record<string, unknown>;
    expect(result.failingTests).toEqual(['a.test.ts']);
    expect(result.readAttestation).toEqual({
      snapshotObservedAt: null,
      snapshotAgeMs: null,
      snapshotAge: null,
      observedCandidate: null,
      candidateCommittedAt: null,
      candidateAgeAtObservationMs: null,
      commitsBehindTip: null,
    });
  });

  it('stamps only the operator-home gate-health row with its registry-derived re-read handle', async () => {
    const row = (install_slug: string, consecutiveReds: number) => ({
      install_slug,
      name: 'green-checkpoint',
      trigger_kind: 'cron',
      trigger_config: { cron: '0 0 * * * *' },
      target_role: 'system:green-checkpoint',
      active: true,
      next_fire_at: new Date('2026-08-12T17:00:00Z'),
      last_fired_at: new Date('2026-08-12T16:00:00Z'),
      group_slug: null,
      metadata: { gate_health: { consecutiveReds } },
    });
    sqlMock.mockResolvedValue([row('home-harness', 2), row('sidestage', 7)]);

    const b = body(await listTool.handler({} as never, { role: 'su', harnessSlug: 'papercusp' } as never));
    expect(b.routines[0].plane?.cells).toEqual([
      expect.objectContaining({
        path: 'health.gate_health.consecutiveReds',
        cell: 'gate.greenCheckpoint.verdict',
        reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.verdict' } },
      }),
    ]);
    expect(b.routines[1]).not.toHaveProperty('plane');
  });

  /**
   * EI-20747395137280903 — the FOURTH instance of the defect {@link healthOf}'s own header
   * predicted ("a per-field fix here is what guarantees a fourth instance").
   *
   * A routine whose `system:` action is registered NOWHERE fires on schedule and does nothing,
   * forever. The detector for it has always worked and has always written its findings to
   * `metadata.validation`; that key simply was not in the projection's allowlist, so the only
   * witness was a `console.error` in journalctl. Every surface an agent would naturally check
   * — `active`, `nextFireAt`, `lastFiredAt` — reports a perfectly healthy routine, which is
   * precisely why this needs a POSITIVE assertion rather than trust in the log.
   *
   * Measured when this landed: 4 routines were live in this state with 210 skipped fires
   * between them.
   */
  it('surfaces metadata.validation so a silently-dead routine stops reading as healthy (EI-20747395137280903)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'coverage-census',
        trigger_kind: 'interval',
        trigger_config: { interval_sec: 900 },
        target_role: 'system:coverage-census',
        // Every one of these reads HEALTHY. That is the bug this test pins.
        active: true,
        next_fire_at: new Date('2026-08-18T13:30:00Z'),
        last_fired_at: new Date('2026-08-18T13:12:11Z'),
        metadata: {
          validation: {
            'unregistered-system-action': {
              occurrences: 25,
              firstSeenMs: 1787028895814,
              lastSeenMs: 1787057475766,
            },
          },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      validation: {
        'unregistered-system-action': { occurrences: 25 },
      },
    });
  });

  /**
   * EI-21297913810967409 — the same defect as the test above, one subsystem over, and the READER
   * half of that fix.
   *
   * The five release watchdogs (green-stall, the stranded-pause scan, main-behind-staging, and
   * both release-trigger guards) each swallow their own failure as a `console.warn (non-fatal)`,
   * so a guard that CANNOT RUN and a guard that ran and found nothing are indistinguishable —
   * both are silence. One of them had been dead for as long as it had existed, querying a column
   * that does not exist (EI-21291109975568717), with no witness but a console line.
   *
   * Each pass now records onto the routine row it watches. That write is proven against real
   * Postgres in release/watchdog-health.integration.test.ts; what THIS test pins is the other
   * end — that the recorded marker actually reaches a reader. Drop the key from the allowlist
   * and the watchdogs go back to writing evidence nobody ever sees, which is the whole bug.
   */
  it('surfaces metadata.watchdog_health so a broken release watchdog stops reading as healthy (EI-21297913810967409)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '15 * * * *' },
        target_role: 'system:green-checkpoint',
        // As with the test above: every one of these reads HEALTHY while the watchdog that
        // would notice otherwise cannot run at all.
        active: true,
        next_fire_at: new Date('2026-08-24T03:15:00Z'),
        last_fired_at: new Date('2026-08-24T02:15:00Z'),
        metadata: {
          watchdog_health: {
            'paused-green-checkpoint': {
              lastError: 'column cp.revoked_at does not exist',
              lastErrorAt: '2026-08-24T02:15:04.000Z',
              consecutiveFailures: 12,
            },
          },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      watchdog_health: {
        'paused-green-checkpoint': { consecutiveFailures: 12 },
      },
    });
  });

  /**
   * The calibration control for the test above. A `toMatchObject` assertion on a projected
   * field passes for the WRONG reason if the projection ever starts echoing metadata wholesale
   * — so prove the allowlist is still an allowlist by sending a key that must NOT come through.
   * Without this, widening `healthOf` to `return metadata` would leave both tests green.
   */
  it('still filters non-operational metadata keys — the allowlist is not an echo', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'coverage-census',
        trigger_kind: 'interval',
        trigger_config: { interval_sec: 900 },
        target_role: 'system:coverage-census',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {
          validation: { 'unregistered-system-action': { occurrences: 25 } },
          // Real key from this table, deliberately not operational — and one of the
          // biggest (measured max 16,613 chars), which is why the allowlist exists at all.
          residue_census: { huge: 'x'.repeat(64) },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toHaveProperty('validation');
    expect(b.routines[0].health).not.toHaveProperty('residue_census');
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

  it('EI-20503768406496801: KEEPS `health` and `lastFiredAt` in the trimmed projection — the gate-health read must work on the DEFAULT tier', async () => {
    // The same defect as `paused` above, one field over. This shaper REBUILDS each
    // row from an allowlist, so a field added to the row mapper never arrives here —
    // it vanishes, and only on the tier agents get by default. Both fields below are
    // promised by this tool's own `returns` block, and CLAUDE.md's tool-routing table
    // sends agents here for gate health specifically so they stop hand-writing
    // `SELECT metadata->'gate_health' FROM harness_shared.routines`. Trimmed away, the
    // documented answer was simply absent and the only way back was that raw SQL.
    const trimmed = listTool.shape!.trimmed!({
      count: 2,
      routines: [
        {
          installSlug: 'sidestage',
          name: 'green-checkpoint',
          cron: '0 15 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:15:00.000Z',
          lastFiredAt: '2026-08-18T14:15:00.000Z',
          group: null,
          paused: null,
          health: { gate_health: { consecutive_reds: 3 }, last_status: 'error' },
        },
        {
          installSlug: 'papercusp',
          name: 'consult-expiry-sweep',
          cron: '0 */5 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:05:00.000Z',
          lastFiredAt: null,
          group: null,
          paused: null,
          // An ACTIVE routine whose handler is registered nowhere: active/nextFireAt
          // both read healthy and this key is the only tell.
          health: { validation: { 'unregistered-system-action': true } },
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };

    // The gate-health read, on the default tier.
    expect(trimmed.routines[0].health).toMatchObject({ gate_health: { consecutive_reds: 3 } });
    // lastFiredAt survives — and it is not redundant with nextFireAt: a STALLED routine
    // keeps advancing nextFireAt while lastFiredAt stays put, so the divergence between
    // the two IS the stall signal. Dropping one side made the pair unreadable.
    expect(trimmed.routines[0].lastFiredAt).toBe('2026-08-18T14:15:00.000Z');
    expect(trimmed.routines[0].nextFireAt).toBe('2026-08-18T15:15:00.000Z');
    // The silently-dead-routine tell survives too.
    expect(trimmed.routines[1].health).toMatchObject({
      validation: { 'unregistered-system-action': true },
    });

    // CONTROL: a row genuinely carrying neither must still say so explicitly rather
    // than omitting the keys — otherwise "no health" and "health was trimmed" are
    // indistinguishable to the reader, which is the ambiguity that hid this bug.
    const bare = listTool.shape!.trimmed!({
      count: 1,
      routines: [
        {
          installSlug: 'papercusp',
          name: 'git-sync',
          cron: '0 */2 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:00:00.000Z',
          lastFiredAt: null,
          group: 'release',
          paused: null,
          health: null,
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };
    expect(bare.routines[0]).toHaveProperty('health', null);
    expect(bare.routines[0]).toHaveProperty('lastFiredAt', null);
  });

  it('CONTROL: the PRE-FIX allowlist is caught — proving the guard above can fail', async () => {
    // A guard that has never failed is a guard nobody has tested. Rather than mutate
    // production code in this shared tree to prove it (the sweep-race the repo
    // forbids), the pre-fix shaper is kept here PERMANENTLY as a deliberately-wrong
    // control: this is the exact 7-key allowlist as it stood before
    // EI-20503768406496801, and the assertions above are re-run against it.
    const preFixTrim = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => ({
        installSlug: r.installSlug ?? null,
        name: r.name ?? null,
        cron: r.cron ?? null,
        active: r.active === true,
        nextFireAt: r.nextFireAt ?? null,
        group: r.group ?? null,
        paused: r.paused ?? null,
      }));

    const row = {
      installSlug: 'sidestage',
      name: 'green-checkpoint',
      cron: '0 15 * * * *',
      active: true,
      nextFireAt: '2026-08-18T15:15:00.000Z',
      lastFiredAt: '2026-08-18T14:15:00.000Z',
      group: null,
      paused: null,
      health: { gate_health: { consecutive_reds: 3 } },
    };

    // The control drops exactly what the reporter observed missing...
    const stale = preFixTrim([row])[0] as Record<string, unknown>;
    expect(stale).not.toHaveProperty('health');
    expect(stale).not.toHaveProperty('lastFiredAt');

    // ...while the REAL shaper keeps them. If a future edit re-slims the allowlist,
    // the real shaper starts behaving like this control and the test above reds.
    const live = listTool.shape!.trimmed!({ count: 1, routines: [row] }, {
      args: {},
    } as never) as { routines: Array<Record<string, unknown>> };
    expect(live.routines[0]).toHaveProperty('health');
    expect(live.routines[0]).toHaveProperty('lastFiredAt');
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

  it('blocks a peer green-checkpoint resume while the serializer hold is active', async () => {
    serializerM.mockResolvedValue({
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-serializer',
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: exact qualification',
      holdReason: 'D-016 sole serializer hold: exact qualification',
    });

    await expect(
      setTool.handler({ name: 'green-checkpoint', active: true } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/serializer hold.*WI-40086.*su-serializer/i);
    expect(controlMock).not.toHaveBeenCalled();
  });

  it('allows the operator-home green-checkpoint resume when admission is clear, authority is free, and no run is active', async () => {
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */10 * * * *' },
        active: false,
        next_fire_at: null,
        metadata: { pause: { reason: 'manual pause', pausedBy: 'su-owner', pausedAtMs: 1 } },
      },
    ]);

    const b = body(
      await setTool.handler({ name: 'green-checkpoint', active: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true, routine: 'home-harness/green-checkpoint' });
    expect(rootM).toHaveBeenCalledOnce();
    expect(admissionM).toHaveBeenCalledOnce();
    expect(serializerM).toHaveBeenCalledWith({ installSlug: 'home-harness' });
    expect(activeRunM).toHaveBeenCalledWith('/integration-root');
  });

  it('applies the same green-checkpoint resume guard to dryRun', async () => {
    serializerM.mockResolvedValue({
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-serializer',
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: exact qualification',
      holdReason: 'D-016 sole serializer hold: exact qualification',
    });

    await expect(
      setTool.handler(
        { name: 'green-checkpoint', active: true, dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    ).rejects.toThrow(/serializer hold/i);
    expect(controlMock).not.toHaveBeenCalled();
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
