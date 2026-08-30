/**
 * deploy-coalesce-stall-detect.test.ts (EI-18835078701597295).
 *
 * The item names two recurrence guards explicitly:
 *   · "a test that drives N consecutive coalesced attempts and asserts an escalation is raised"
 *   · "plus one asserting a holderAlive:false coalesce escalates immediately"
 * Both are here, first, and named as such. The rest guard the streak-reset rule, which is
 * where this decider is easiest to get subtly wrong: reset on the wrong status and a real
 * stall is silently cleared by unrelated deploy telemetry.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDeployCoalesceStreak,
  detectDeployCoalesceStall,
  type DeployCoalesceEvent,
} from './deploy-coalesce-stall-detect';

/** Newest-first, as `recentPipelineEvents` returns. */
const coalesce = (holder = 'release-deploy:4242:abc', holderAlive: boolean | null = true): DeployCoalesceEvent => ({
  status: 'coalesced',
  detail: { holder, holderAlive },
});
const outcome = (status: 'ok' | 'failed' | 'rolled-back' | 'refused'): DeployCoalesceEvent => ({ status, detail: {} });

describe('evaluateDeployCoalesceStreak — the two guards the item names', () => {
  it('GUARD 1: N consecutive coalesced attempts raise an escalation', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce(), coalesce(), coalesce()],
      threshold: 3,
    });
    expect(v.escalate).toBe(true);
    expect(v.trigger).toBe('streak');
    expect(v.streak).toBe(3);
    // The finding must name the holder — "COALESCED" alone is what made the original
    // symptom unactionable.
    expect(detectDeployCoalesceStall(v)[0]?.body).toContain('release-deploy:4242:abc');
  });

  it('GUARD 2: a holderAlive:false coalesce escalates on the FIRST occurrence, not the third', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce('release-deploy:9999:dead', false)],
      threshold: 3,
    });
    expect(v.escalate).toBe(true);
    expect(v.trigger).toBe('dead-holder');
    expect(v.streak).toBe(1); // well below the threshold — the rule is independent of it
    expect(detectDeployCoalesceStall(v)[0]?.title).toContain('DEAD');
  });
});

describe('evaluateDeployCoalesceStreak — streak accounting', () => {
  it('stays quiet below the threshold', () => {
    const v = evaluateDeployCoalesceStreak({ events: [coalesce(), coalesce()], threshold: 3 });
    expect(v.escalate).toBe(false);
    expect(v.streak).toBe(2);
    expect(detectDeployCoalesceStall(v)).toEqual([]);
  });

  it('a COMPLETED attempt resets the run — 2 recent coalesces behind an ok is not a stall', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce(), coalesce(), outcome('ok'), coalesce(), coalesce(), coalesce()],
      threshold: 3,
    });
    expect(v.escalate).toBe(false);
    expect(v.streak).toBe(2); // the run stops at the `ok`; the older three do not carry over
  });

  it.each(['ok', 'failed', 'rolled-back', 'refused'] as const)('status %s ends the run', (status) => {
    const v = evaluateDeployCoalesceStreak({ events: [coalesce(), outcome(status), coalesce()], threshold: 2 });
    expect(v.streak).toBe(1);
    expect(v.escalate).toBe(false);
  });

  it('a BREADCRUMB status does NOT reset the run — this is the silent-blinding failure mode', () => {
    // stale-lock-reclaimed / certification-* are emitted ALONGSIDE attempts, not as the
    // outcome of one. If they reset the streak, any unrelated deploy telemetry landing
    // mid-stall clears the alarm and the outage goes back to being invisible.
    const v = evaluateDeployCoalesceStreak({
      events: [
        coalesce(),
        { status: 'stale-lock-reclaimed', detail: {} },
        coalesce(),
        { status: 'certification-launched', detail: {} },
        coalesce(),
      ],
      threshold: 3,
    });
    expect(v.escalate).toBe(true);
    expect(v.streak).toBe(3);
  });

  it('an unknown future status is ignored rather than treated as a reset', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce(), { status: 'some-status-added-later', detail: {} }, coalesce(), coalesce()],
      threshold: 3,
    });
    expect(v.streak).toBe(3);
  });

  it('an empty history is not an alarm', () => {
    const v = evaluateDeployCoalesceStreak({ events: [], threshold: 3 });
    expect(v.escalate).toBe(false);
    expect(v.streak).toBe(0);
  });
});

describe('evaluateDeployCoalesceStreak — holder liveness reporting', () => {
  it('reports UNKNOWN liveness distinctly from alive, and says the lock will not self-heal', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce('some-foreign-holder', null), coalesce('some-foreign-holder', null), coalesce('some-foreign-holder', null)],
      threshold: 3,
    });
    expect(v.escalate).toBe(true);
    expect(v.holderAlive).toBeNull();
    expect(v.reason).toContain('UNKNOWN');
    // The actionable half: an unparseable owner is never reclaimed, so waiting is futile.
    expect(v.reason).toContain('self-heal');
  });

  it('a live holder is reported as WEDGED, not as a crash', () => {
    const v = evaluateDeployCoalesceStreak({ events: [coalesce(), coalesce(), coalesce()], threshold: 3 });
    expect(v.holderAlive).toBe(true);
    expect(v.reason).toContain('WEDGED');
  });

  it('reads holder/liveness from the MOST RECENT coalesce, not an older one', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce('newest:1:x', false), coalesce('older:2:y', true)],
      threshold: 3,
    });
    expect(v.holder).toBe('newest:1:x');
    expect(v.trigger).toBe('dead-holder');
  });

  it('tolerates a missing/!malformed detail payload without throwing', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [{ status: 'coalesced' }, { status: 'coalesced', detail: null }, { status: 'coalesced', detail: {} }],
      threshold: 3,
    });
    expect(v.escalate).toBe(true);
    expect(v.holder).toBeNull();
    expect(v.holderAlive).toBeNull();
  });
});

describe('currency window — an alarm must be clearable by fixing the problem', () => {
  const NOW = 1_700_000_000_000;
  const aged = (minutesAgo: number, holderAlive: boolean | null = true): DeployCoalesceEvent => ({
    status: 'coalesced',
    detail: { holder: 'release-deploy:1:x', holderAlive },
    createdAtMs: NOW - minutesAgo * 60_000,
  });

  it('a RECENT streak escalates', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [aged(2), aged(5), aged(9)],
      threshold: 3,
      now: NOW,
      maxAgeMs: 60 * 60_000,
    });
    expect(v.escalate).toBe(true);
  });

  it('a STALE streak does NOT — deploy attempts stopped, so it is history, not a live stall', () => {
    // Without this bound the last three rows stay coalesces forever once attempts stop, and
    // the alarm re-fires indefinitely with no action that can clear it.
    const v = evaluateDeployCoalesceStreak({
      events: [aged(180), aged(190), aged(200)],
      threshold: 3,
      now: NOW,
      maxAgeMs: 60 * 60_000,
    });
    expect(v.escalate).toBe(false);
    expect(v.streak).toBe(3); // the run is still REPORTED, just not escalated
    expect(v.reason).toContain('history, not a live stall');
  });

  it('the currency window also gates the dead-holder fast path', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [aged(300, false)],
      threshold: 3,
      now: NOW,
      maxAgeMs: 60 * 60_000,
    });
    expect(v.escalate).toBe(false);
  });

  it('events with NO timestamp are read unbounded — a caller supplying none gets what it asked for', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce(), coalesce(), coalesce()],
      threshold: 3,
      now: NOW,
      maxAgeMs: 60 * 60_000,
    });
    expect(v.escalate).toBe(true);
  });
});

describe('kill switch', () => {
  it('threshold<=0 disables the alarm even on a long dead-holder run', () => {
    const v = evaluateDeployCoalesceStreak({
      events: [coalesce('x', false), coalesce('x', false), coalesce('x', false)],
      threshold: 0,
    });
    expect(v.escalate).toBe(false);
    expect(v.reason).toContain('kill switch');
    expect(detectDeployCoalesceStall(v)).toEqual([]);
  });
});

describe('detectDeployCoalesceStall — finding shape', () => {
  it('files as an operator-scoped bug with a STABLE key so re-fires dedup onto one EI', () => {
    const v = evaluateDeployCoalesceStreak({ events: [coalesce(), coalesce(), coalesce()], threshold: 3 });
    const [f] = detectDeployCoalesceStall(v);
    expect(f).toMatchObject({
      source: 'deploy-coalesce-stall',
      key: 'deploy-coalesce-stall',
      severity: 'major',
      kind: 'bug',
      scope: 'operator',
    });
    expect(f?.paths).toContain('apps/operator/lib/release/deploy-cli.ts');
  });

  it('the title carries no counts, so search-first dedup matches across ticks', () => {
    // WatchdogSignal.title is the search-first dedup key and is documented as STABLE — no
    // counts, no timestamps. A title reading "coalesced 3x" stops matching the next tick's
    // "4x" and re-files a brand-new EI on every single attempt. Both triggers are covered
    // here: an earlier draft of this detector embedded the streak count in the STREAK title
    // only, and a dead-holder-only assertion did not catch it.
    const streak3 = detectDeployCoalesceStall(
      evaluateDeployCoalesceStreak({ events: [coalesce(), coalesce(), coalesce()], threshold: 3 }),
    )[0];
    const streak5 = detectDeployCoalesceStall(
      evaluateDeployCoalesceStreak({
        events: [coalesce(), coalesce(), coalesce(), coalesce(), coalesce()],
        threshold: 3,
      }),
    )[0];
    expect(streak3?.title).toBe(streak5?.title);
    expect(streak3?.title).not.toMatch(/\d/);

    const dead1 = detectDeployCoalesceStall(
      evaluateDeployCoalesceStreak({ events: [coalesce('h', false)], threshold: 3 }),
    )[0];
    const dead2 = detectDeployCoalesceStall(
      evaluateDeployCoalesceStreak({ events: [coalesce('h', false), coalesce('h', false)], threshold: 3 }),
    )[0];
    expect(dead1?.title).toBe(dead2?.title);
    expect(dead1?.title).not.toMatch(/\d/);

    // ...but the counts must still be REPORTED, just in the body where they belong.
    expect(streak5?.body).toContain('5');
  });
});
