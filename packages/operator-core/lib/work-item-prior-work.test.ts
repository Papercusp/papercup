/**
 * work-item-prior-work — P-001 of fleet-leadership-continuity-and-actuation-2026-08-01.
 *
 * The guarantee under test: an item that has ALREADY BEEN WORKED must never be
 * indistinguishable from a never-started one — especially when no checkpoint exists, which is
 * precisely the case the two pre-existing guards (EI-529's checkpoint hint, WI-5826's terminal
 * warning) both miss.
 *
 * `priorWorkWarning` is pure, so the wording guarantee is pinned directly here rather than only
 * through the tool. That is deliberate: the escalation on `hasCheckpoint: false` is the entire
 * value of this feature, and a future edit that softened it would otherwise pass silently.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORSHIP_REVALIDATION_MIN_AGE_MS,
  REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS,
  REPEAT_DEFERRAL_MIN_QUIET_MS,
  authorshipRevalidationHintFromRow,
  authorshipRevalidationWarning,
  distinctPriorSessionCount,
  excludeCurrentClaimant,
  parseWorkedByHistory,
  priorWorkHintFromRow,
  priorWorkWarning,
  repeatDeferralQuietEnough,
  type AuthorshipRevalidationRow,
  type ClaimTimePriorWorkHint,
} from './work-item-prior-work';

const hint = (over: Partial<ClaimTimePriorWorkHint> = {}): ClaimTimePriorWorkHint => ({
  lastReleasedBy: null,
  releasedAtMs: null,
  attempts: 0,
  priorWorkers: [],
  hasCheckpoint: false,
  ...over,
});

describe('priorWorkWarning', () => {
  it('returns null for no hint — a genuinely fresh claim is completely unaffected', () => {
    expect(priorWorkWarning(null)).toBeNull();
  });

  it('ESCALATES when prior work exists but NO checkpoint was written (the WI-6096 shape)', () => {
    const w = priorWorkWarning(
      hint({ lastReleasedBy: 'su-bdd5566b', releasedAtMs: Date.parse('2026-07-26T18:28:00Z') }),
    );
    // The three things this message must do, each pinned separately so a reword cannot quietly
    // drop one: name the hazard, name the absent checkpoint, and name the concrete next action.
    expect(w).toMatch(/PRIOR WORK/);
    expect(w).toMatch(/NO checkpoint/);
    expect(w).toMatch(/READ THE SOURCE/);
    expect(w).toContain('su-bdd5566b');
    expect(w).toContain('2026-07-26T18:28:00.000Z');
  });

  it('softens when a checkpoint DOES exist — EI-529 already tells the claimant what happened', () => {
    const w = priorWorkWarning(hint({ lastReleasedBy: 'su-peer', hasCheckpoint: true }));
    expect(w).toMatch(/PRIOR WORK/);
    expect(w).toMatch(/checkpoint exists/);
    // NEGATIVE CONTROL for the escalation: the loud variant's distinguishing phrases must be
    // ABSENT here. Without this, a bug collapsing both branches to the same text would still
    // pass the escalation test above.
    expect(w).not.toMatch(/NO checkpoint/);
    expect(w).not.toMatch(/READ THE SOURCE/);
  });

  // WI-6737: the third state. Every caller reads the checkpoint hint under a `.catch(() => null)`,
  // so before this branch existed a checkpoint-store OUTAGE was indistinguishable from a checkpoint
  // that was never written — and this function went on to assert the latter in those exact words.
  // A transport failure rendered as a claim about history is the defect; these pin that it can't
  // happen again in either direction.
  describe("hasCheckpoint: 'unknown' (the checkpoint store could not be READ)", () => {
    it('says the answer is UNKNOWN and never that no checkpoint was written', () => {
      const w = priorWorkWarning(hint({ lastReleasedBy: 'su-peer', hasCheckpoint: 'unknown' }));
      expect(w).toMatch(/PRIOR WORK/);
      expect(w).toMatch(/UNKNOWN/);
      expect(w).toMatch(/could NOT BE READ/i);
      // The whole point: the false-branch's categorical claim about history must NOT appear.
      // This is the assertion that would have caught the original bug.
      expect(w).not.toMatch(/NO checkpoint was ever written/);
      expect(w).not.toMatch(/never-started/);
      expect(w).toContain('su-peer');
    });

    it('tells the reader NOT to start rebuilding, and to re-read once reachable', () => {
      const w = priorWorkWarning(hint({ attempts: 2, hasCheckpoint: 'unknown' }));
      expect(w).toMatch(/Do NOT start rebuilding/i);
      expect(w).toMatch(/work_items:get/);
      // the ordinary fact rendering still applies to this branch
      expect(w).toMatch(/2 prior claim attempts/);
    });

    it('is DISTINCT from both boolean branches — no two of the three collapse', () => {
      const base = { lastReleasedBy: 'su-peer' as const };
      const unknown = priorWorkWarning(hint({ ...base, hasCheckpoint: 'unknown' }));
      const absent = priorWorkWarning(hint({ ...base, hasCheckpoint: false }));
      const present = priorWorkWarning(hint({ ...base, hasCheckpoint: true }));
      expect(new Set([unknown, absent, present]).size).toBe(3);
    });

    it("treats ONLY the literal 'unknown' as unknown — a truthy value is still a present checkpoint", () => {
      // Guards the `=== true` / `=== 'unknown'` comparisons against a future refactor that
      // reintroduces a loose truthiness check and silently re-merges the branches.
      expect(priorWorkWarning(hint({ hasCheckpoint: true }))).toMatch(/checkpoint exists/);
      expect(priorWorkWarning(hint({ hasCheckpoint: false }))).toMatch(/NO checkpoint was ever written/);
    });
  });

  it('reports attempt count and pluralises it', () => {
    expect(priorWorkWarning(hint({ attempts: 1 }))).toMatch(/1 prior claim attempt\b/);
    expect(priorWorkWarning(hint({ attempts: 3 }))).toMatch(/3 prior claim attempts/);
  });

  it('lists prior workers WITHOUT repeating the last releaser', () => {
    const w = priorWorkWarning(hint({ lastReleasedBy: 'su-a', priorWorkers: ['su-a', 'su-b'] }));
    expect(w).toContain('su-b');
    // 'su-a' appears once (as the releaser), not again in the previously-worked-by list.
    expect(w!.match(/su-a/g)).toHaveLength(1);
  });

  it('still warns when the only signal is an attempt count (no releaser, no timestamp)', () => {
    // The weakest possible signal must still produce a warning — this is the row shape left by a
    // holder that died without ever releasing cleanly.
    expect(priorWorkWarning(hint({ attempts: 2 }))).toMatch(/PRIOR WORK/);
  });
});

// EI-20284291276800931: the sub-threshold message tells the claimant to READ THE CHECKPOINT and
// start. For an item several sessions have already picked up and put back down, that is the wrong
// instruction — reading the checkpoint, re-confirming its stated blocker, and deferring is exactly
// what each of them did. These pin the inversion, and pin that it cannot fire on ordinary churn.
describe('repeated-deferral escalation (EI-20284291276800931)', () => {
  const workers = (n: number) => Array.from({ length: n }, (_, i) => `su-w${i}`);

  it('does NOT fire below the threshold — ordinary hand-off churn is completely unaffected', () => {
    const w = priorWorkWarning(hint({ priorWorkers: workers(2), hasCheckpoint: true }));
    expect(w).not.toMatch(/REPEATEDLY DEFERRED/);
    expect(w).toMatch(/checkpoint exists/);
  });

  it('fires at the threshold and INVERTS the instruction away from "read the checkpoint"', () => {
    const w = priorWorkWarning(hint({ priorWorkers: workers(3), hasCheckpoint: true }));
    expect(w).toMatch(/REPEATEDLY DEFERRED/);
    expect(w).toContain('3 distinct sessions');
    expect(w).toMatch(/ACCEPTANCE CRITERION/);
    expect(w).toMatch(/OVER-SPECIFIED/);
    // The whole defect: the sub-threshold wording must NOT survive into this branch.
    expect(w).not.toMatch(/read it \(above\) before starting/);
  });

  it('counts DISTINCT sessions, unioning last_released_by instead of adding it', () => {
    // Legacy shape — a releaser recorded with an empty history is still a session.
    expect(priorWorkWarning(hint({ priorWorkers: ['su-a', 'su-b'], lastReleasedBy: 'su-c' }))).toContain(
      '3 distinct sessions',
    );
    // Present-day shape — the releaser is ALSO inside the history. Summing would report 4 here and
    // push genuine two-session churn over the threshold, so the union is load-bearing, not tidiness.
    expect(
      priorWorkWarning(hint({ priorWorkers: ['su-a', 'su-b', 'su-c'], lastReleasedBy: 'su-c' })),
    ).toContain('3 distinct sessions');
    expect(distinctPriorSessionCount(hint({ priorWorkers: ['su-a', 'su-b'], lastReleasedBy: 'su-b' }))).toBe(2);
  });

  it('still names the missing checkpoint when there is none, without softening it', () => {
    const w = priorWorkWarning(hint({ priorWorkers: workers(4), hasCheckpoint: false }));
    expect(w).toMatch(/REPEATEDLY DEFERRED/);
    expect(w).toMatch(/NO checkpoint was ever written/);
  });

  it("does NOT override the 'unknown' outage guarantee — WI-6737 outranks this prompt", () => {
    // You cannot judge an acceptance criterion you were just unable to read, and "do not rebuild"
    // is the safe move during an outage. The count is APPENDED, never substituted for it.
    const w = priorWorkWarning(hint({ priorWorkers: workers(5), hasCheckpoint: 'unknown' }));
    expect(w).toMatch(/Do NOT start rebuilding/i);
    expect(w).toMatch(/could NOT BE READ/i);
    expect(w).not.toMatch(/NO checkpoint was ever written/);
    expect(w).toContain('5 distinct sessions');
  });

  // WI-2145689. A durable finding retired distinct-worker churn as a stuck-item signal 0-for-2:
  // WI-35902 drew 14 workers and 12 claims in THREE HOURS and then completed normally. The count
  // alone cannot separate that from a real stall, and the worst false positive is the loudest one —
  // the gate red WI-212675, re-claimed by 26 sessions within a day, where the correct response is
  // the one-fixer stand-down and NOT "go re-judge the acceptance criterion".
  describe('quiet-time gate — many sessions RECENTLY is contention, not deferral', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    const hoursAgo = (h: number) => now - h * 60 * 60 * 1_000;

    it('does NOT escalate on a hot item re-claimed within the quiet window (the WI-212675 shape)', () => {
      const w = priorWorkWarning(
        hint({ priorWorkers: workers(26), lastReleasedBy: 'su-peer', releasedAtMs: hoursAgo(6), hasCheckpoint: true }),
        now,
      );
      expect(w).not.toMatch(/REPEATEDLY DEFERRED/);
      // It must fall back to the ordinary message, not go silent — the row still has prior work.
      expect(w).toMatch(/PRIOR WORK/);
      expect(w).toMatch(/checkpoint exists/);
    });

    it('DOES escalate once the item has gone quiet past the window', () => {
      const w = priorWorkWarning(
        hint({ priorWorkers: workers(3), lastReleasedBy: 'su-peer', releasedAtMs: hoursAgo(72), hasCheckpoint: true }),
        now,
      );
      expect(w).toMatch(/REPEATEDLY DEFERRED/);
    });

    it('is a genuine boundary, not an always-true guard — both sides checked at the cutoff', () => {
      // Without this pair the gate could be hard-wired open and every test above would still pass.
      const justInside = repeatDeferralQuietEnough(now - REPEAT_DEFERRAL_MIN_QUIET_MS + 1, now);
      const exactlyAt = repeatDeferralQuietEnough(now - REPEAT_DEFERRAL_MIN_QUIET_MS, now);
      expect(justInside).toBe(false);
      expect(exactlyAt).toBe(true);
    });

    it('fails toward the prompt when no release timestamp is recorded', () => {
      // Documented judgement call, not a measurement: no qualifying live row lacked the timestamp.
      expect(repeatDeferralQuietEnough(null, now)).toBe(true);
    });
  });

  it('drives the cutoff from the exported constant so wording and threshold cannot drift apart', () => {
    expect(REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS).toBe(3);
    const below = priorWorkWarning(hint({ priorWorkers: workers(REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS - 1) }));
    const at = priorWorkWarning(hint({ priorWorkers: workers(REPEAT_DEFERRAL_MIN_DISTINCT_SESSIONS) }));
    expect(below).not.toMatch(/REPEATEDLY DEFERRED/);
    expect(at).toMatch(/REPEATEDLY DEFERRED/);
  });
});

describe('current-claimant exclusion', () => {
  const claimedRow = {
    taken_by: 'su-current',
    attempts: 0,
    last_released_by: null,
    last_released_at: null,
    worked_by_history: [{ owner: 'su-current' }],
  };

  it('does not classify a fresh post-claim row as prior work', () => {
    expect(priorWorkHintFromRow(claimedRow, { currentClaimant: 'su-current' })).toBeNull();
  });

  it('retains a peer history entry while excluding only the current claimant', () => {
    expect(
      priorWorkHintFromRow(
        { ...claimedRow, worked_by_history: [{ owner: 'su-peer' }, { owner: 'su-current' }] },
        { currentClaimant: 'su-current' },
      ),
    ).toMatchObject({ priorWorkers: ['su-peer'] });
  });

  it('preserves real release provenance from an earlier claim by the same agent', () => {
    expect(
      priorWorkHintFromRow(
        { ...claimedRow, last_released_by: 'su-current', last_released_at: '2026-08-19T12:00:00Z' },
        { currentClaimant: 'su-current' },
      ),
    ).toMatchObject({ lastReleasedBy: 'su-current', priorWorkers: [] });
  });

  it('normalizes a missing or whitespace-only claimant without mutating the input', () => {
    const workers = ['su-peer', 'su-current'];
    expect(excludeCurrentClaimant(workers, '  ')).toEqual(workers);
    expect(excludeCurrentClaimant(workers, ' su-current ')).toEqual(['su-peer']);
    expect(workers).toEqual(['su-peer', 'su-current']);
  });
});

describe('parseWorkedByHistory', () => {
  it('accepts a plain string array', () => {
    expect(parseWorkedByHistory(['su-a', 'su-b'])).toEqual(['su-a', 'su-b']);
  });

  it('accepts object entries under any of the drifted key names', () => {
    expect(parseWorkedByHistory([{ owner: 'su-a' }, { ownerId: 'su-b' }, { agent: 'su-c' }, { by: 'su-d' }])).toEqual([
      'su-a',
      'su-b',
      'su-c',
      'su-d',
    ]);
  });

  it('de-duplicates and drops blanks', () => {
    expect(parseWorkedByHistory(['su-a', 'su-a', '  ', { owner: '' }])).toEqual(['su-a']);
  });

  it('returns [] for shapes it does not recognise instead of throwing', () => {
    // The column's shape has drifted historically; an unrecognised one must degrade to "no
    // workers", never fail the surrounding claim.
    for (const bad of [null, undefined, 'not-an-array', 42, {}, [1, true, null]]) {
      expect(() => parseWorkedByHistory(bad)).not.toThrow();
      expect(parseWorkedByHistory(bad)).toEqual([]);
    }
  });
});

const NOW = Date.parse('2026-08-13T08:00:00Z');
const authorshipRow = (over: Partial<AuthorshipRevalidationRow> = {}): AuthorshipRevalidationRow => ({
  created_ts: NOW - AUTHORSHIP_REVALIDATION_MIN_AGE_MS - 60_000,
  created_by: 'su-ended-author',
  attempts: 0,
  last_released_at: null,
  last_progress_at: null,
  worked_by_history: [],
  author_session_ended_at: '2026-08-08T20:05:49.863Z',
  author_session_ended_by: 'reaper',
  author_has_open_session: false,
  ...over,
});

describe('authorshipRevalidationHintFromRow', () => {
  it('qualifies only the measured aged + no-recorded-work + explicitly-ended-session conjunction', () => {
    expect(authorshipRevalidationHintFromRow(authorshipRow(), NOW)).toEqual({
      createdBy: 'su-ended-author',
      itemCreatedAtMs: NOW - AUTHORSHIP_REVALIDATION_MIN_AGE_MS - 60_000,
      itemAgeMs: AUTHORSHIP_REVALIDATION_MIN_AGE_MS + 60_000,
      authorSessionEndedAtMs: Date.parse('2026-08-08T20:05:49.863Z'),
      authorSessionEndedBy: 'reaper',
    });
  });

  it.each([
    ['too young', { created_ts: NOW - AUTHORSHIP_REVALIDATION_MIN_AGE_MS + 1 }],
    ['missing author', { created_by: null }],
    ['no affirmative ended session', { author_session_ended_at: null }],
    ['open continuation exists', { author_has_open_session: true }],
    ['prior attempt recorded', { attempts: 1 }],
    ['prior release recorded', { last_released_at: '2026-08-01T00:00:00Z' }],
    ['prior progress recorded', { last_progress_at: '2026-08-01T00:00:00Z' }],
    ['prior worker recorded', { worked_by_history: [{ owner: 'su-peer' }] }],
    ['history shape is unknown', { worked_by_history: { owner: 'su-peer' } }],
  ] as const)('stays silent when %s', (_label, over) => {
    expect(authorshipRevalidationHintFromRow(authorshipRow(over), NOW)).toBeNull();
  });

  it('does not infer session death from missing activity/presence evidence', () => {
    expect(
      authorshipRevalidationHintFromRow(
        authorshipRow({ author_session_ended_at: null, author_has_open_session: false }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe('authorshipRevalidationWarning', () => {
  it('states the proved facts, avoids a dead-author claim, and requires source/premise verification', () => {
    const warning = authorshipRevalidationWarning(authorshipRevalidationHintFromRow(authorshipRow(), NOW));
    expect(warning).toMatch(/AUTHORSHIP REVALIDATION/);
    expect(warning).toMatch(/14 days old/);
    expect(warning).toContain('su-ended-author');
    expect(warning).toContain('recorded ended');
    expect(warning).toContain('recorded by reaper');
    expect(warning).toMatch(/verify its premises against current source\/tests/i);
    expect(warning).toMatch(/does NOT say whether the requested work is missing or already done/i);
    expect(warning).not.toMatch(/author (?:is|was) dead/i);
  });

  it('returns null when the conjunction does not qualify', () => {
    expect(authorshipRevalidationWarning(null)).toBeNull();
  });
});
