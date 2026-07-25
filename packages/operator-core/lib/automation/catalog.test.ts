/**
 * Automation catalog classification tests.
 *
 * The stakes here are specific: `spawnsAgent` is what renders the "tokens" flag in
 * the Blender/Docs panes, and `classifyRoutine` decides WHICH pane a routine appears
 * in. A miss on either means a routine that spends the owner's weekly Claude limit
 * is invisible or unpausable — the exact failure these panes were built to end
 * (owner ask 2026-07-25). So the real cron names observed on the box are pinned.
 */
import { describe, expect, it } from 'vitest';
import { classifyRoutine, cronCadence, routineSpawnsAgent } from './catalog';

describe('routineSpawnsAgent', () => {
  // Every one of these was observed firing on 2026-07-25 and billing tokens.
  it.each([
    'bp-singleton-scout-0',
    'bp-singleton-red-queen-0',
    'gym-cycle',
    'template-gym',
    'improvement-implement',
    'improvement-watchdog',
    'improvement-triage',
    'overwatch-wake',
    'pot-wake',
    'wake-brain',
    'pot-eval-battery',
    'oddsmith-prospector-cadence',
    'loop-su-d7fa235d-a4c8-4e2d-a41e-f4937fe66e64',
  ])('flags %s as agent-spawning (it costs tokens)', (name) => {
    expect(routineSpawnsAgent(name)).toBe(true);
  });

  // Pure system sweeps — SQL/git/gc only. Flagging these would cry wolf and train
  // the owner to ignore the flag that matters.
  it.each([
    'git-sync',
    'green-checkpoint',
    'cross-hive-outbox-drain',
    'precompute-derived-reads',
    'telemetry-retention',
    'idle-session-reaper',
    'gc-plan-runs',
    'pr-poll',
  ])('does not flag the pure system sweep %s', (name) => {
    expect(routineSpawnsAgent(name)).toBe(false);
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
