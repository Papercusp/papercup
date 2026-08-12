/**
 * Automation catalog classification tests.
 *
 * The stakes are specific: the spend classification renders the "tokens" flag the
 * owner uses to decide what to pause, and `classifyRoutine` decides which category a
 * routine carries. A miss means a routine spending the weekly Claude limit is
 * invisible or unpausable — the failure these panes were built to end.
 *
 * ⚠ The `routineSpawnsAgent` name-regex this file used to pin is RETIRED
 * (agents-system-pane-split-2026-07-26 D-001). Its assertions were themselves wrong:
 * this file previously pinned `template-gym`, `improvement-watchdog`,
 * `improvement-triage` and `wake-brain` as "observed firing and billing tokens",
 * and none of them bills anything. That is what a name-regex buys you — a test that
 * faithfully asserts the guess. Spend now derives from `target_role`; the cases
 * below are the corrections, and routine-classification.test.ts holds the rest.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyRoutine,
  collapseFanOut,
  cronCadence,
  loopCadence,
  routineSpawnsAgent,
  type AutomationRoutine,
} from './catalog';
import { spendForTargetRole } from './routine-classification';

describe('spend classification (replaces the retired routineSpawnsAgent regex)', () => {
  it.each([
    ['bp-singleton-scout-0', 'system:blueprint-run'],
    ['bp-singleton-red-queen-0', 'system:blueprint-run'],
    ['pot-eval-battery', 'system:blueprint-run'],
    ['hive-wake', 'system:blueprint-run'],
    ['gym-cycle', 'system:gym-cycle'],
    ['improvement-implement', 'system:improvement-implement'],
    ['overwatch-wake', 'system:overwatch-launch'],
    ['loop-su-d7fa235d-a4c8-4e2d-a41e-f4937fe66e64', 'system:loop-wake'],
  ])('flags %s (%s) as a spender', (_name, role) => {
    expect(spendForTargetRole(role)).toBe('llm');
  });

  // Pure system sweeps — SQL/git/gc only. Flagging these cries wolf and trains the
  // owner to ignore the flag that matters.
  it.each([
    ['git-sync', 'system:git-sync'],
    ['green-checkpoint', 'system:green-checkpoint'],
    ['cross-hive-outbox-drain', 'system:cross-hive-outbox-drain'],
    ['precompute-derived-reads', 'system:precompute-derived-reads'],
    ['telemetry-retention', 'system:telemetry-retention'],
    ['idle-session-reaper', 'system:idle-session-reaper'],
    ['gc-plan-runs', 'system:gc-plan-runs'],
    ['pr-poll', 'system:pr-poll'],
  ])('does not flag the pure system sweep %s', (_name, role) => {
    expect(spendForTargetRole(role)).toBe('none');
  });

  // The regressions this change exists to fix — each was asserted as a spender by
  // the retired regex, and each is provably free.
  it.each([
    ['wake-brain', 'system:wake-brain', 'its handler is `async (ctx) => { void ctx; }`'],
    ['improvement-watchdog', 'system:improvement-watchdog', 'a SQL pass that files work items'],
    ['improvement-triage', 'system:improvement-triage', 'explicitly never dispatches'],
    ['improvement-human-digest', 'system:improvement-human-digest', 'ranks and sends'],
  ])('corrects the old false positive %s (%s)', (_name, role) => {
    expect(spendForTargetRole(role)).toBe('none');
  });

  it('refuses the retired name-regex rather than answering wrongly', () => {
    expect(() => routineSpawnsAgent()).toThrow(/retired/i);
  });
});

describe('loopCadence', () => {
  it('renders a loop reschedule interval, which carries no cron', () => {
    expect(loopCadence(60)).toBe('every 1m');
    expect(loopCadence(300)).toBe('every 5m');
    expect(loopCadence(3600)).toBe('every 1h');
    expect(loopCadence(90)).toBe('every 90s');
  });

  it('has no cadence for a missing or nonsensical interval', () => {
    expect(loopCadence(null)).toBeNull();
    expect(loopCadence(0)).toBeNull();
    expect(loopCadence(-5)).toBeNull();
  });
});

describe('classifyRoutine', () => {
  it('routes self-improvement routines to the Blender pane', () => {
    expect(classifyRoutine('gym-cycle', 'self-improvement')).toBe('learning');
    expect(classifyRoutine('bp-singleton-regret-0', 'self-improvement')).toBe('learning');
  });

  it('routes documentation routines to the Docs pane even when grouped elsewhere', () => {
    // The owner looks for "the documentation agent" under Docs regardless of which
    // group_slug it happens to carry — docs classification must win over the group.
    expect(classifyRoutine('docs-corpus-audit', 'self-improvement')).toBe('docs');
    expect(classifyRoutine('knowledge-pack-hygiene', 'health')).toBe('docs');
  });

  it('routes the whole improvement-* family to the Blender pane regardless of group_slug (P-008)', () => {
    // The bug this fixes: improvement-watchdog is grouped `health` in the DB while its
    // siblings improvement-implement / -triage / -human-digest are grouped
    // `self-improvement`. Before name-before-group ordering, the watchdog — the pipeline's
    // single biggest work-item emitter — rendered in the Agents/Health pane, so pausing
    // "the Blender" demonstrably did NOT stop it (2026-07-25 duplicate-churn). The name
    // must win over the group so the family presents as ONE pausable pane.
    expect(classifyRoutine('improvement-watchdog', 'health')).toBe('learning');
    expect(classifyRoutine('improvement-implement', 'self-improvement')).toBe('learning');
    expect(classifyRoutine('improvement-triage', 'self-improvement')).toBe('learning');
    expect(classifyRoutine('improvement-human-digest', 'health')).toBe('learning');
    // Even ungrouped, the name shape alone lands it in learning.
    expect(classifyRoutine('improvement-watchdog', null)).toBe('learning');
  });

  it('does not sweep a genuinely-health routine into learning by the P-008 ordering', () => {
    // Regression guard for name-before-group: a health routine whose name matches NO
    // learning/docs pattern must still land in the Health pane, not get pulled forward.
    expect(classifyRoutine('cargo-test', 'health')).toBe('health');
    expect(classifyRoutine('pg-vacuum-sweep', 'health')).toBe('health');
  });

  it('routes agent-armed continuation loops to agent-loops', () => {
    expect(classifyRoutine('loop-su-abc', 'agent-loops')).toBe('agent-loops');
    expect(classifyRoutine('loop-su-abc', null)).toBe('agent-loops');
  });

  it('falls back on name shape when a routine is ungrouped', () => {
    expect(classifyRoutine('bp-singleton-transfer-0', null)).toBe('learning');
    expect(classifyRoutine('git-sync', null)).toBe('infra');
    expect(classifyRoutine('coord-probe-canary', null)).toBe('supervision');
  });

  it('keeps supervision and health groups on their own', () => {
    expect(classifyRoutine('claim-discipline-watch', 'supervision')).toBe('supervision');
    expect(classifyRoutine('cargo-test', 'health')).toBe('health');
  });
});

describe('cronCadence', () => {
  it('renders the real 6-field crons observed on the box', () => {
    expect(cronCadence('0 */30 * * * *')).toBe('every 30m');
    expect(cronCadence('0 */15 * * * *')).toBe('every 15m');
    expect(cronCadence('0 10,40 * * * *')).toBe('2×/hour');
    expect(cronCadence('0 20 * * * *')).toBe('hourly');
    expect(cronCadence('0 0 9 * * *')).toBe('daily');
    expect(cronCadence('0 43 */6 * * *')).toBe('every 6h');
  });

  it('returns null for an event-driven routine with no cron', () => {
    expect(cronCadence(null)).toBeNull();
  });
});

// ── collapseFanOut ─────────────────────────────────────────────────────────────
// `git-sync` is ONE routine installed on 19 pots, `green-checkpoint` on 14,
// `cross-hive-outbox-drain` on 13, `hive-wake` on 16. Rendered per-install those
// four names alone were 60+ peer rows — most of why the owner read the pane as a
// wall ("there are like 100 git-sync schedules/routines").
describe('collapseFanOut', () => {
  const row = (
    over: Partial<AutomationRoutine> & { name: string; installSlug: string },
  ): AutomationRoutine => ({
    group: null,
    category: 'infra',
    cron: '0 */2 * * * *',
    cadence: 'every 2m',
    active: true,
    spend: 'none',
    spendWhy: null,
    spawnsAgent: false,
    kind: 'scheduled',
    family: 'git-release',
    liveness: 'running',
    armedState: 'armed',
    control: 'routine',
    needsAttention: false,
    installs: [over.installSlug],
    ownerId: null,
    ownerLastActiveAt: null,
    triggerLabel: null,
    lastFiredAt: null,
    nextFireAt: null,
    source: 'routines',
    controllable: true,
    ...over,
    // `Partial<AutomationRoutine>` widens every key with `| undefined`, so spreading
    // `over` last re-opens the required `flagKey: string | null` to `undefined`.
    // Re-normalize after the spread: an explicit override still wins, an absent one
    // falls back to the declared default rather than landing as `undefined`.
    flagKey: over.flagKey ?? null,
    // Same widening trap for the required `controlWhy: string` (WI-6313).
    controlWhy: over.controlWhy ?? 'Pause or resume it right here.',
  });

  it('collapses one routine installed on many pots into a single row', () => {
    const out = collapseFanOut([
      row({ name: 'git-sync', installSlug: 'papercusp' }),
      row({ name: 'git-sync', installSlug: 'oddsmith' }),
      row({ name: 'git-sync', installSlug: 'hello-world' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.installs).toEqual(['hello-world', 'oddsmith', 'papercusp']);
  });

  it('keeps distinct routines apart', () => {
    const out = collapseFanOut([
      row({ name: 'git-sync', installSlug: 'papercusp' }),
      row({ name: 'green-checkpoint', installSlug: 'papercusp' }),
    ]);
    expect(out.map((r) => r.name).sort()).toEqual(['git-sync', 'green-checkpoint']);
  });

  // One stalled pot must not hide behind fifteen healthy ones — the collapsed row
  // reports the WORST liveness, or collapsing would bury exactly what it should show.
  it('reports the worst liveness across installs', () => {
    const out = collapseFanOut([
      row({ name: 'git-sync', installSlug: 'a', liveness: 'running' }),
      row({ name: 'git-sync', installSlug: 'b', liveness: 'stalled' }),
      row({ name: 'git-sync', installSlug: 'c', liveness: 'running' }),
    ]);
    expect(out[0]!.liveness).toBe('stalled');
    expect(out[0]!.needsAttention).toBe(true);
  });

  it('flags a collapsed row when any install has an unknown armed state', () => {
    const out = collapseFanOut([
      row({ name: 'gateway-watchdog-poll', installSlug: 'a', armedState: 'armed' }),
      row({ name: 'gateway-watchdog-poll', installSlug: 'b', armedState: 'unknown' }),
    ]);
    expect(out[0]!.armedState).toBe('unknown');
    expect(out[0]!.needsAttention).toBe(true);
  });

  it('is active when any install is active', () => {
    const out = collapseFanOut([
      row({ name: 'git-sync', installSlug: 'a', active: false, liveness: 'dormant' }),
      row({ name: 'git-sync', installSlug: 'b', active: true, liveness: 'running' }),
    ]);
    expect(out[0]!.active).toBe(true);
  });

  it('reports dormant only when every install is dormant', () => {
    const out = collapseFanOut([
      row({ name: 'hive-wake', installSlug: 'a', active: false, liveness: 'dormant' }),
      row({ name: 'hive-wake', installSlug: 'b', active: false, liveness: 'dormant' }),
    ]);
    expect(out[0]!.liveness).toBe('dormant');
    expect(out[0]!.active).toBe(false);
  });

  it('takes the most recent fire and the earliest next fire', () => {
    const out = collapseFanOut([
      row({
        name: 'git-sync',
        installSlug: 'a',
        lastFiredAt: '2026-07-26T10:00:00.000Z',
        nextFireAt: '2026-07-26T18:00:00.000Z',
      }),
      row({
        name: 'git-sync',
        installSlug: 'b',
        lastFiredAt: '2026-07-26T13:00:00.000Z',
        nextFireAt: '2026-07-26T14:00:00.000Z',
      }),
    ]);
    expect(out[0]!.lastFiredAt).toBe('2026-07-26T13:00:00.000Z');
    expect(out[0]!.nextFireAt).toBe('2026-07-26T14:00:00.000Z');
  });

  // Each loop belongs to a distinct session and its name is already unique, so
  // there is nothing to collapse — and collapsing them would merge unrelated agents.
  it('leaves per-session loops alone', () => {
    const out = collapseFanOut([
      row({ name: 'loop-su-aaa', installSlug: 'papercusp', kind: 'loop', family: 'loops' }),
      row({ name: 'loop-su-bbb', installSlug: 'papercusp', kind: 'loop', family: 'loops' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('is only controllable when every install is', () => {
    const out = collapseFanOut([
      row({ name: 'git-sync', installSlug: 'a', controllable: true }),
      row({ name: 'git-sync', installSlug: 'b', controllable: false }),
    ]);
    expect(out[0]!.controllable).toBe(false);
  });
});
