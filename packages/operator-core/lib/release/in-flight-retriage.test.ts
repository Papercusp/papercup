/**
 * EI-18669342433807110 — a stale-candidate auto-refire in progress, made visible.
 *
 * `parseInFlightRetriage` is the pure half (PG-free): it decides whether a raw
 * `gate_health.inFlightRetriage` value read back from Postgres is trustworthy right now. The write
 * side (`recordInFlightRetriage`) is a thin best-effort SQL merge, exercised live by
 * green-checkpoint-real-deps.test.ts / manual verification, not unit-tested here (no PG in this
 * suite) — see gate-verdict-freshness.test.ts's "Rule 4" block for how a parsed marker feeds the
 * freshness verdict a reader actually acts on.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/in-flight-retriage.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  attributeRetriageToRun,
  describeRefireBudget,
  parseInFlightRetriage,
  IN_FLIGHT_RETRIAGE_MAX_AGE_MS,
  describeRunnerCodeFreshness,
  readRunnerCodeCommittedAtMs,
  GATE_RUNNER_SOURCE_PATH,
  RUNNER_PROCESS_BOOTED_AT_MS,
} from './in-flight-retriage';

const NOW = Date.parse('2026-07-26T02:00:00Z');

const VALID = {
  fromCandidate: '30f88df7abcd',
  refiringCandidate: '221dc407abcd',
  refireAttempt: 1,
  maxRefires: 2,
  failingFiles: ['a.test.ts', 'b.test.ts'],
  observedAtMs: NOW - 60_000, // 1 minute ago — fresh
};

describe('parseInFlightRetriage', () => {
  it('⭐ parses a fresh, well-formed marker', () => {
    const v = parseInFlightRetriage(VALID, NOW);
    expect(v).toEqual(VALID);
  });

  it('returns null for a missing marker (the common case — no refire running)', () => {
    expect(parseInFlightRetriage(undefined, NOW)).toBeNull();
    expect(parseInFlightRetriage(null, NOW)).toBeNull();
  });

  it('returns null for a non-object', () => {
    expect(parseInFlightRetriage('not-an-object', NOW)).toBeNull();
    expect(parseInFlightRetriage(42, NOW)).toBeNull();
  });

  it('returns null when a required field is missing or the wrong type (malformed/old-shape blob)', () => {
    expect(parseInFlightRetriage({ ...VALID, fromCandidate: undefined }, NOW)).toBeNull();
    expect(parseInFlightRetriage({ ...VALID, refireAttempt: '1' }, NOW)).toBeNull();
    expect(parseInFlightRetriage({ ...VALID, observedAtMs: undefined }, NOW)).toBeNull();
  });

  it('defaults failingFiles to [] when absent or non-string-array, rather than rejecting the whole marker', () => {
    const { failingFiles, ...rest } = VALID;
    expect(parseInFlightRetriage(rest, NOW)?.failingFiles).toEqual([]);
    expect(parseInFlightRetriage({ ...VALID, failingFiles: 'oops' }, NOW)?.failingFiles).toEqual([]);
    expect(parseInFlightRetriage({ ...VALID, failingFiles: ['ok.ts', 42] }, NOW)?.failingFiles).toEqual(['ok.ts']);
  });

  it('⭐ rejects an ABANDONED marker (older than IN_FLIGHT_RETRIAGE_MAX_AGE_MS) — a crashed run must not wedge every future read into "still refiring" forever', () => {
    const abandoned = { ...VALID, observedAtMs: NOW - IN_FLIGHT_RETRIAGE_MAX_AGE_MS - 1 };
    expect(parseInFlightRetriage(abandoned, NOW)).toBeNull();
  });

  it('accepts a marker right at the boundary (not yet abandoned)', () => {
    const boundary = { ...VALID, observedAtMs: NOW - IN_FLIGHT_RETRIAGE_MAX_AGE_MS + 1 };
    expect(parseInFlightRetriage(boundary, NOW)).not.toBeNull();
  });

  /**
   * EI-19343516395023183. Both publish sites in green-checkpoint.ts have persisted these three
   * since EI-19343532231631821 added them — and this parser, an explicit object literal, dropped
   * every one. So the fields existed on the interface, existed in Postgres, and reached NO reader:
   * `gate-verdict-freshness` and `git-pipeline-position` both went on rendering the CHARGED counter
   * alone. That is the failure this test pins.
   */
  it('⭐ carries charged/totalRefires/absoluteCeiling through — they are written by both publish sites and were silently dropped here', () => {
    const full = { ...VALID, charged: false, totalRefires: 5, absoluteCeiling: 6 };
    const v = parseInFlightRetriage(full, NOW);
    expect(v?.charged).toBe(false);
    expect(v?.totalRefires).toBe(5);
    expect(v?.absoluteCeiling).toBe(6);
  });

  it('omits the newer fields entirely for a pre-EI-19343532231631821 marker, rather than inventing a 0', () => {
    const v = parseInFlightRetriage(VALID, NOW);
    expect(v).not.toBeNull();
    expect(v).not.toHaveProperty('totalRefires');
    expect(v).not.toHaveProperty('absoluteCeiling');
    expect(v).not.toHaveProperty('charged');
  });

  it('ignores a wrong-typed newer field without rejecting the whole marker (it is optional, not required)', () => {
    const v = parseInFlightRetriage({ ...VALID, totalRefires: 'five', charged: 'no' }, NOW);
    expect(v).not.toBeNull();
    expect(v).not.toHaveProperty('totalRefires');
    expect(v).not.toHaveProperty('charged');
  });
});

describe('describeRefireBudget', () => {
  const base = { refireAttempt: 0, maxRefires: 2 };

  /**
   * The bug in one assertion. `refireAttempt` advances ONLY on a FAILED rescue, so a run whose
   * rescues all succeed sits at 0/2 forever while `totalRefires` climbs to the ceiling. Testing
   * `refireAttempt >= maxRefires` — what both call sites did — reports budget REMAINING in exactly
   * the case there is none, which is the direction that costs a caller a wasted full suite.
   */
  it('⭐ reports atCap when the ABSOLUTE CEILING is reached even though the charged budget is untouched', () => {
    const b = describeRefireBudget({ ...base, totalRefires: 6, absoluteCeiling: 6 });
    expect(b.atCap).toBe(true);
    expect(b.label).toContain('refire 6/6');
    expect(b.label).toContain('charged budget 0/2');
  });

  it('reports atCap when the CHARGED budget is spent even though the ceiling has room', () => {
    expect(describeRefireBudget({ refireAttempt: 2, maxRefires: 2, totalRefires: 2, absoluteCeiling: 6 }).atCap).toBe(true);
  });

  it('reports budget remaining when NEITHER bound is reached', () => {
    const b = describeRefireBudget({ ...base, totalRefires: 3, absoluteCeiling: 6 });
    expect(b.atCap).toBe(false);
    expect(b.label).toBe('refire 3/6 performed, charged budget 0/2 spent');
  });

  it('reports atCap when auto-refire is DISABLED (maxRefires 0) — there is no budget to have left', () => {
    expect(describeRefireBudget({ refireAttempt: 0, maxRefires: 0 }).atCap).toBe(true);
  });

  it('degrades to the charged-only reading for a pre-EI-19343532231631821 marker, rather than treating absent as 0', () => {
    const b = describeRefireBudget(base);
    expect(b.label).toBe('attempt 0/2');
    expect(b.atCap).toBe(false);
  });
});

describe('attributeRetriageToRun', () => {
  const marker = parseInFlightRetriage(VALID, NOW)!;

  it('returns null when there is no marker (= no refire in flight, the common case)', () => {
    expect(attributeRetriageToRun(null, { started_at: new Date(NOW).toISOString() })).toBeNull();
  });

  it('⭐ attributes a marker written AFTER the run started to that run', () => {
    const started = new Date(marker.observedAtMs - 60_000).toISOString();
    expect(attributeRetriageToRun(marker, { started_at: started })?.belongsToRun).toBe(true);
  });

  /**
   * The gate's run-lock is a singleton, so a marker predating the current run's start was written
   * by an earlier one. Presenting it as this run's rescue would silence a genuinely new red with
   * a stale one — the same trap Rule 4 in gate-verdict-freshness guards with `fromCandidate`.
   */
  it('⭐ REFUSES to attribute a marker written BEFORE the run started — that is an earlier run\'s', () => {
    const started = new Date(marker.observedAtMs + 60_000).toISOString();
    expect(attributeRetriageToRun(marker, { started_at: started })?.belongsToRun).toBe(false);
  });

  it('answers null (UNCONFIRMED, not false) when the run start is unreadable — absence of proof is not proof of absence', () => {
    expect(attributeRetriageToRun(marker, { started_at: null })?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, {})?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, undefined)?.belongsToRun).toBeNull();
    expect(attributeRetriageToRun(marker, { started_at: 'not-a-date' })?.belongsToRun).toBeNull();
  });
});

/**
 * WI-38224 — the JUDGE's own freshness, as opposed to the candidate's.
 *
 * Every other field on the marker describes the code being judged. `runnerBootedAtMs` describes
 * the code doing the judging, and it exists because `runGreenCheckpoint` recurses IN-PROCESS on an
 * auto-refire: the candidate fields advance onto newer and newer tips while the runner's module
 * graph stays pinned to whatever was on disk at boot. A fix committed to green-checkpoint.ts after
 * that instant cannot take effect in the run, so a gate that stays red after a correct fix looks
 * exactly like a fix that did not work — and the cheap next move is to re-fix a correct guard.
 *
 * Run: cd packages/operator-core && npx vitest run lib/release/in-flight-retriage.test.ts
 */
describe('describeRunnerCodeFreshness — is this verdict even capable of reflecting the fix?', () => {
  const BOOT = Date.parse('2026-08-12T15:40:14Z');

  it('⭐ reports STALE when the runner\'s code was committed AFTER its process booted', () => {
    const fix = Date.parse('2026-08-12T15:55:33Z'); // 15m after boot — the real WI-38218 case
    const f = describeRunnerCodeFreshness({ runnerBootedAtMs: BOOT }, fix);
    expect(f.verdict).toBe('stale');
    expect(f.behindByMs).toBe(fix - BOOT);
    // The note must carry the OPERATIVE warning, not merely the timestamps: its whole job is to
    // stop the reader concluding the fix failed.
    expect(f.note).toMatch(/NOT evidence the fix failed/i);
    expect(f.note).toMatch(/next run/i);
  });

  it('⭐ reports FRESH when the process booted at or after its own last code commit', () => {
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: BOOT }, BOOT - 60_000).verdict).toBe('fresh');
    // Boundary: committed at the same instant is NOT stale — the process can have loaded it.
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: BOOT }, BOOT).verdict).toBe('fresh');
  });

  it('⭐ answers UNKNOWN (never fresh) when either instant is missing — an unstamped marker is not a freshness claim', () => {
    expect(describeRunnerCodeFreshness({}, Date.now()).verdict).toBe('unknown');
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: BOOT }, null).verdict).toBe('unknown');
    expect(describeRunnerCodeFreshness(null, null).verdict).toBe('unknown');
    expect(describeRunnerCodeFreshness(undefined, undefined).note).toMatch(/Do NOT read this as fresh/i);
  });

  /**
   * CONTROL — a deliberately-wrong implementation, kept permanently so the assertions above are
   * proven to be capable of failing. The natural wrong version compares the wrong direction (asking
   * whether the runner booted after the commit and calling THAT stale); it must not satisfy the
   * stale case. Without this, all three tests above would also pass against a function that always
   * returned 'stale'.
   */
  it('⭐ CONTROL: a reversed-comparison implementation FAILS the stale case, so the assertions bite', () => {
    const reversed = (bootedAt: number, committedAt: number) => (bootedAt > committedAt ? 'stale' : 'fresh');
    const fix = Date.parse('2026-08-12T15:55:33Z');
    expect(reversed(BOOT, fix)).toBe('fresh'); // the wrong answer …
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: BOOT }, fix).verdict).toBe('stale'); // … and the right one
  });

  /**
   * CALIBRATION — the control above only means something if the real subject is wired to a real
   * process. Derived from process.uptime(), so it must be in the past and no older than the process.
   */
  it('RUNNER_PROCESS_BOOTED_AT_MS describes THIS process — in the past, and consistent with its uptime', () => {
    const now = Date.now();
    expect(RUNNER_PROCESS_BOOTED_AT_MS).toBeLessThanOrEqual(now);
    expect(now - RUNNER_PROCESS_BOOTED_AT_MS).toBeLessThanOrEqual(Math.ceil(process.uptime() * 1000) + 5_000);
  });

  it('⭐ parseInFlightRetriage CARRIES runnerBootedAtMs — the field is dropped unless the explicit literal lists it', () => {
    const raw = {
      fromCandidate: 'aaaaaaa',
      refiringCandidate: 'bbbbbbb',
      refireAttempt: 0,
      maxRefires: 2,
      failingFiles: [],
      observedAtMs: Date.now(),
      runnerBootedAtMs: BOOT,
    };
    expect(parseInFlightRetriage(raw)?.runnerBootedAtMs).toBe(BOOT);
    // …and a pre-WI-38224 marker parses fine, simply without the field (=> 'unknown', not 'fresh').
    const { runnerBootedAtMs: _omitted, ...legacy } = raw;
    const parsedLegacy = parseInFlightRetriage(legacy);
    expect(parsedLegacy).not.toBeNull();
    expect(parsedLegacy?.runnerBootedAtMs).toBeUndefined();
    expect(describeRunnerCodeFreshness(parsedLegacy, Date.now()).verdict).toBe('unknown');
  });
});

/**
 * EI-20265492291034092 — the IMPURE half. `describeRunnerCodeFreshness` is only as good as the
 * commit instant handed to it, and every failure mode of THAT read has to land on `null` (=>
 * verdict 'unknown'), never on a number that reads as a positive freshness claim.
 */
describe('readRunnerCodeCommittedAtMs — every failed read must answer null, never a plausible number', () => {
  const SEC = 1_786_540_000;

  it('scales git %ct (epoch SECONDS) to ms — the unit describeRunnerCodeFreshness compares against', async () => {
    const got = await readRunnerCodeCommittedAtMs('/repo', () => `${SEC}\n`);
    expect(got).toBe(SEC * 1000);
    // Calibration: the scaled value is directly comparable to a boot instant in ms. Without the
    // ×1000 this reads as 1970 and EVERY run would look 'fresh' — the exact false-positive the
    // verdict exists to prevent.
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: SEC * 1000 - 60_000 }, got).verdict).toBe('stale');
  });

  it('asks git for the RUNNER file specifically, in the root it was given', async () => {
    const seen: { root: string; rel: string }[] = [];
    await readRunnerCodeCommittedAtMs('/some/root', (root, rel) => {
      seen.push({ root, rel });
      return `${SEC}`;
    });
    expect(seen).toEqual([{ root: '/some/root', rel: GATE_RUNNER_SOURCE_PATH }]);
    expect(GATE_RUNNER_SOURCE_PATH).toBe('apps/operator/lib/release/green-checkpoint.ts');
  });

  it.each([
    ['read failed', null],
    ['untracked / no commits (empty stdout)', ''],
    ['whitespace only', '  \n'],
    ['not a number', 'fatal: not a git repository'],
    ['zero', '0'],
    ['negative', '-5'],
  ])('answers null on %s — which drives the verdict to unknown, not fresh', async (_label, stdout) => {
    const got = await readRunnerCodeCommittedAtMs('/repo', () => stdout as string | null);
    expect(got).toBeNull();
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: Date.now() }, got).verdict).toBe('unknown');
  });

  it('never throws into its caller — a reader that explodes answers null', async () => {
    await expect(
      readRunnerCodeCommittedAtMs('/repo', () => {
        throw new Error('git missing');
      }),
    ).resolves.toBeNull();
  });

  it('⭐ CONTROL — a reader wrong by the SECONDS/MS factor is CAUGHT, so these tests can fail', async () => {
    // Permanent mutant: the same reading without the scale. If this ever stops reading 'fresh',
    // the assertions above have stopped measuring the unit at all.
    const unscaled = SEC;
    expect(describeRunnerCodeFreshness({ runnerBootedAtMs: SEC * 1000 - 60_000 }, unscaled).verdict).toBe('fresh');
    expect(unscaled).not.toBe(await readRunnerCodeCommittedAtMs('/repo', () => `${SEC}`));
  });
});
