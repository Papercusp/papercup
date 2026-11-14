import { describe, expect, it } from 'vitest';
import {
  STALL_TIER_CRITICAL_MS,
  STALL_TIER_MAJOR_MS,
  defaultStallCaptureConditionKey,
  gitSyncStallConditionKey,
  raiseStallIncidentSeverity,
  stallKindMentioned,
  stallSeverityComment,
  stallSeverityRaise,
  stallTierFor,
  type OpenStallIncident,
  type StallSeverityDeps,
  type StallTier,
} from './pipeline-stall-incidents';

const MIN = 60_000;

describe('stallTierFor — severity rises with duration', () => {
  it('maps the tier boundaries exactly', () => {
    expect(stallTierFor(0)).toBe('minor');
    expect(stallTierFor(STALL_TIER_MAJOR_MS - 1)).toBe('minor');
    expect(stallTierFor(STALL_TIER_MAJOR_MS)).toBe('major');
    expect(stallTierFor(STALL_TIER_CRITICAL_MS - 1)).toBe('major');
    expect(stallTierFor(STALL_TIER_CRITICAL_MS)).toBe('critical');
    expect(stallTierFor(4 * 24 * 60 * MIN)).toBe('critical');
  });

  it('treats a non-finite or negative duration as minor, never critical', () => {
    expect(stallTierFor(Number.NaN)).toBe('minor');
    expect(stallTierFor(-5)).toBe('minor');
  });
});

describe('stallSeverityRaise — raise-only', () => {
  it('raises the observed flood rows (nit) once the watchdog confirms a stall', () => {
    expect(stallSeverityRaise('nit', 5 * MIN)).toBe('minor');
    expect(stallSeverityRaise(null, 5 * MIN)).toBe('minor');
    expect(stallSeverityRaise('bogus', 5 * MIN)).toBe('minor');
  });

  it('raises at each threshold', () => {
    expect(stallSeverityRaise('minor', 61 * MIN)).toBe('major');
    expect(stallSeverityRaise('major', 6 * 60 * MIN)).toBe('critical');
    expect(stallSeverityRaise('nit', 4 * 24 * 60 * MIN)).toBe('critical');
  });

  it('never lowers and never re-raises to the same tier', () => {
    expect(stallSeverityRaise('minor', 5 * MIN)).toBeNull();
    expect(stallSeverityRaise('major', 61 * MIN)).toBeNull();
    expect(stallSeverityRaise('critical', 5 * MIN)).toBeNull();
    expect(stallSeverityRaise('CRITICAL', 7 * 60 * MIN)).toBeNull();
  });
});

describe('stallSeverityComment', () => {
  it('is identical for every post of one tier, so an idempotent replay never conflicts', () => {
    expect(stallSeverityComment('git-sync (papercusp)', 'minor', 'major'))
      .toBe(stallSeverityComment('git-sync (papercusp)', 'minor', 'major'));
    expect(stallSeverityComment('git-sync (papercusp)', 'minor', 'major')).not.toMatch(/\d+\s*min/);
  });
});

function fakeDeps(rows: OpenStallIncident[], opts: { bumpOk?: boolean } = {}) {
  const severity = new Map(rows.map((r) => [r.id, r.severity]));
  const bumps: Array<{ id: string; to: StallTier }> = [];
  const comments: Array<{ id: string; body: string; key: string }> = [];
  const deps: StallSeverityDeps = {
    findOpenIncidents: async () => [...severity].map(([id, s]) => ({ id, severity: s })),
    bumpSeverity: async (id, to) => {
      if (opts.bumpOk === false) return false;
      bumps.push({ id, to });
      severity.set(id, to);
      return true;
    },
    comment: async (id, body, key) => {
      comments.push({ id, body, key });
    },
  };
  return { deps, bumps, comments, severity };
}

describe('raiseStallIncidentSeverity', () => {
  const input = (ms: number) => ({ keys: ['git-sync-stall:papercusp'], subject: 'git-sync (papercusp)', stallDurationMs: ms });

  it('raises each open incident and comments once per tier crossing', async () => {
    const f = fakeDeps([{ id: 'WI-1', severity: 'nit' }]);
    expect(await raiseStallIncidentSeverity(input(10 * MIN), f.deps)).toEqual([{ id: 'WI-1', from: 'nit', to: 'minor' }]);
    // Re-signals inside the tier are silent.
    expect(await raiseStallIncidentSeverity(input(30 * MIN), f.deps)).toEqual([]);
    expect(await raiseStallIncidentSeverity(input(90 * MIN), f.deps)).toEqual([{ id: 'WI-1', from: 'minor', to: 'major' }]);
    expect(await raiseStallIncidentSeverity(input(7 * 60 * MIN), f.deps)).toEqual([{ id: 'WI-1', from: 'major', to: 'critical' }]);
    expect(await raiseStallIncidentSeverity(input(8 * 60 * MIN), f.deps)).toEqual([]);
    expect(f.comments.map((c) => c.key)).toEqual([
      'stall-severity:WI-1:minor',
      'stall-severity:WI-1:major',
      'stall-severity:WI-1:critical',
    ]);
  });

  it('does not comment when the write was refused', async () => {
    const f = fakeDeps([{ id: 'WI-1', severity: 'minor' }], { bumpOk: false });
    expect(await raiseStallIncidentSeverity(input(90 * MIN), f.deps)).toEqual([]);
    expect(f.comments).toEqual([]);
  });

  it('touches an incident once even when two keys find it', async () => {
    const f = fakeDeps([{ id: 'WI-1', severity: 'nit' }]);
    f.deps.findOpenIncidents = async () => [{ id: 'WI-1', severity: 'nit' }, { id: 'WI-1', severity: 'nit' }];
    expect(await raiseStallIncidentSeverity(input(90 * MIN), f.deps)).toHaveLength(1);
    expect(f.bumps).toEqual([{ id: 'WI-1', to: 'major' }]);
  });

  it('does nothing without keys or with a non-finite duration', async () => {
    const f = fakeDeps([{ id: 'WI-1', severity: 'nit' }]);
    expect(await raiseStallIncidentSeverity({ ...input(90 * MIN), keys: ['  '] }, f.deps)).toEqual([]);
    expect(await raiseStallIncidentSeverity(input(Number.NaN), f.deps)).toEqual([]);
    expect(f.bumps).toEqual([]);
  });
});

describe('gitSyncStallConditionKey', () => {
  it('keys submodule installs to their superproject harness, so one stall is one incident', () => {
    expect(gitSyncStallConditionKey('papercusp/libs/papercusp-db')).toBe('git-sync-stall:papercusp');
    expect(gitSyncStallConditionKey('papercusp')).toBe('git-sync-stall:papercusp');
  });
});

describe('stallKindMentioned — unkeyed captures coalesce onto the open incident', () => {
  it('matches the observed duplicate-row phrasing', () => {
    expect(stallKindMentioned('git-sync has been frozen for 4 days, nothing pushed')).toBe('git-sync');
    expect(stallKindMentioned('git-sync stalled: no commits since Tuesday')).toBe('git-sync');
    expect(stallKindMentioned('staging-sync stuck on the same sha')).toBe('staging-sync');
  });

  it('does not match a mention without a stall word, or a stall word without the subsystem', () => {
    expect(stallKindMentioned('git-sync content guard flagged a secret')).toBeNull();
    expect(stallKindMentioned('the gate is stalled')).toBeNull();
  });
});

describe('defaultStallCaptureConditionKey — a stall sighting attaches to one row per harness', () => {
  it('keys a bug or observation whose title reports a stall, by harness', () => {
    expect(defaultStallCaptureConditionKey({
      kind: 'bug', title: 'git-sync stalled: no commits since 08:00', harness: 'papercusp',
    })).toBe('git-sync-stall:papercusp');
    expect(defaultStallCaptureConditionKey({
      kind: 'change', lane: 'observation', title: 'staging-sync stuck on the same sha', harness: 'papercusp',
    })).toBe('staging-sync-stall:papercusp');
  });

  it('two reports of the same stall from different agents share one key', () => {
    const a = defaultStallCaptureConditionKey({ kind: 'bug', title: 'git-sync frozen for 4 days', harness: 'papercusp' });
    const b = defaultStallCaptureConditionKey({ kind: 'bug', title: 'Git sync not pushing anything', harness: 'papercusp' });
    expect(a).toBeDefined();
    expect(a).toBe(b);
  });

  it('falls back to the first body line when the title is omitted', () => {
    expect(defaultStallCaptureConditionKey({
      kind: 'bug', body: '\n  git-sync wedged on papercusp\nlong evidence follows', harness: 'papercusp',
    })).toBe('git-sync-stall:papercusp');
  });

  it('leaves change/feature proposals and body-only mentions unkeyed', () => {
    expect(defaultStallCaptureConditionKey({
      kind: 'change', title: 'make git-sync recover when stalled', harness: 'papercusp',
    })).toBeUndefined();
    expect(defaultStallCaptureConditionKey({
      kind: 'bug', title: 'gate verdict is stale', body: 'probably because git-sync stalled earlier', harness: 'papercusp',
    })).toBeUndefined();
  });
});
