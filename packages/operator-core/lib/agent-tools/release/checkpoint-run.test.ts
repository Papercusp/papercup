/**
 * release:checkpoint-run — the manual GATE-run verb (WI-1320 follow-up). Mocks the detached
 * launch primitive so the handler's role-gate + reply shape are asserted without firing a suite.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/release/checkpoint-run.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WI-6946: the handler now preflights pending migrations (applyPendingMigrationsNow) BEFORE
// launching, so every test needs this mocked or it would open a REAL Postgres connection.
// Default: nothing pending, matching what every pre-existing test in this file assumes.
// Hoisted (vi.mock, not vi.doMock) so it applies to every test unless a specific test
// overrides it with its own vi.doMock after vi.resetModules().
vi.mock('../../db-boot-migrate', () => ({
  applyPendingMigrationsNow: vi.fn(async () => ({ applied: 0, failed: [] })),
}));

const MAKE_CTX = (role = 'operator') =>
  ({ log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role } as never);

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

/**
 * P-004: the handler now also asks whether the judged candidate CONTAINS the caller's
 * files. That read really shells out to git against the live repo — un-stubbed it made
 * these unit tests depend on whatever this box happened to have uncommitted (it did:
 * the assertion below started failing with a list of the author's own in-flight files).
 * Stub it to "nothing to report" so each case exercises only the branch it names; the
 * containment logic itself is tested in candidate-contains.test.ts and
 * release-checkpoint-launch.test.ts.
 */
/**
 * EI-20025784115349280 — the pre-launch exclusion gate, pinned OPEN. Its real implementation
 * forks git + systemctl against the live repo, so any test that passes `paths` and does not
 * inject this is testing whatever the fleet happened to commit in the last four minutes.
 * A test that wants the gate to FIRE supplies its own verdict instead of this one.
 */
const PRELAUNCH_OPEN = vi.fn(async () => ({
  refuse: false,
  proceedReason: 'no-declared-paths' as const,
  candidate: null,
  tip: null,
  quietCutSec: null,
  blockedPaths: [],
  waitSec: null,
}));

const NO_CONTAINMENT = vi.fn(async () => ({
  candidateSha: null,
  tipSha: null,
  source: 'caller-supplied' as const,
  included: [],
  missing: [],
  unknown: [],
  paths: [],
  excludedCommitsTouchingYourFiles: [],
  testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
  warning: null,
}));

beforeEach(() => {
  vi.resetModules();
  NO_CONTAINMENT.mockClear();
});
afterEach(() => {
  vi.doUnmock('../../release-checkpoint-launch');
  vi.doUnmock('../../release/in-flight-retriage');
  vi.doUnmock('../../db-boot-migrate');
});

/**
 * EI-19343516395023183 — the cron-held in-flight shape these refire cases share. A run that
 * auto-refires keeps this EXACT envelope (`started_at`/pid belong to the outer frame and never
 * move across the in-process recursion), which is precisely why the reply needs the marker: the
 * refusal payload alone cannot distinguish "wedged" from "mid-rescue".
 */
const CRON_HELD_RUN = {
  active: true,
  unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
  candidate: 'stale00checkout00head',
  current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
  current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
  candidate_stale: false,
  started_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  elapsed_sec: 1800,
  eta_sec: 1500,
  held_externally: true,
};

/** Stub ONLY the PG read; `describeRefireBudget`/`attributeRetriageToRun` stay real, so these
 *  cases exercise the genuine budget + attribution logic rather than a restatement of it. */
async function mockRefire(marker: Record<string, unknown> | null, alreadyRunning: Record<string, unknown> = CRON_HELD_RUN) {
  vi.doMock('../../release/in-flight-retriage', async (orig) => ({
    ...(await orig()),
    readInFlightRetriage: vi.fn(async () => marker),
  }));
  vi.doMock('../../release-checkpoint-launch', async (orig) => ({
    ...(await orig()),
    checkpointCandidateContainment: NO_CONTAINMENT,
    launchDetachedCheckpoint: vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning,
    })),
  }));
  const { default: tool } = await import('./checkpoint-run');
  return parse((await tool.handler({}, MAKE_CTX())) as never);
}

/**
 * EI-19343516395023183. The gate publishes `gate_health.inFlightRetriage` the instant it decides to
 * auto-refire, and every OTHER agent-facing surface already read it — coord:orient, dev:pipeline_position,
 * /admin/git. Not this one: the single verb whose misuse does damage, because firing it inside the
 * re-triage window DISCARDS the rescue and costs a full ~55min suite (green-checkpoint.ts:2566).
 * On 2026-08-02 that gap cost three agents a morning and produced a near-miss recommendation to
 * fire exactly this verb into a live rescue.
 */
describe('EI-19343516395023183: an in-flight auto-refire is surfaced on the already_running refusal', () => {
  const MARKER = {
    fromCandidate: '6f4181447486a33e4b471b82dee3ed0893c3efa6',
    refiringCandidate: '16dbb52a7849320e27832500bf2157f00b1db1c3',
    refireAttempt: 1,
    maxRefires: 2,
    failingFiles: ['hygiene.test.ts', 'release-actions.test.ts'],
    observedAtMs: Date.now() - 60_000, // after CRON_HELD_RUN started ⇒ attributable to it
    charged: true,
    totalRefires: 1,
    absoluteCeiling: 6,
  };

  it('⭐ leads the note with a STAND DOWN and names both candidates', async () => {
    const b = await mockRefire(MARKER);
    expect(String(b.note)).toMatch(/^🚨 AUTO-REFIRE IN FLIGHT — STAND DOWN/);
    expect(String(b.note)).toContain('16dbb52a7849'); // the sha being judged NOW
    expect(String(b.note)).toContain('6f4181447486'); // the one already discarded
    expect(String(b.note)).toMatch(/Do NOT fire a manual run/);
    expect(b).toMatchObject({
      in_flight_retriage: {
        from_candidate: '6f4181447486',
        refiring_candidate: '16dbb52a7849',
        at_cap: false,
        belongs_to_this_run: true,
        charged: true,
      },
    });
  });

  it('⭐ tells the caller not to go fix the files the abandoned red named — they already passed at tip', async () => {
    const b = await mockRefire(MARKER);
    expect(String(b.note)).toMatch(/already PASSED at tip — do not go fix them/);
    expect(String(b.note)).toContain('hygiene.test.ts');
  });

  /** The marker is the run's own published observation; `candidate` on the cron path is the
   *  checkpoint checkout's live HEAD — an inference that changes between reads. */
  it('⭐ containment is checked against the MARKER candidate, not the probed checkout HEAD', async () => {
    await mockRefire(MARKER);
    expect(NO_CONTAINMENT).toHaveBeenCalledWith(expect.objectContaining({ candidateSha: MARKER.refiringCandidate }));
  });

  it('warns that a red will STICK once the absolute ceiling is reached, even with the charged budget untouched', async () => {
    const b = await mockRefire({ ...MARKER, refireAttempt: 0, charged: false, totalRefires: 6 });
    expect(String(b.note)).toMatch(/LAST refire/);
    expect((b.in_flight_retriage as Record<string, unknown>).at_cap).toBe(true);
  });

  /** The run-lock is a singleton, so a marker predating this run's start is an EARLIER run's.
   *  Reporting it would silence a genuinely new red with a stale rescue. */
  it('⭐ does NOT stand the caller down on a marker written BEFORE this run started', async () => {
    const b = await mockRefire({ ...MARKER, observedAtMs: Date.parse(CRON_HELD_RUN.started_at) - 60_000 });
    expect(b.in_flight_retriage).toBeNull();
    expect(String(b.note)).not.toMatch(/STAND DOWN/);
    expect(String(b.note)).toMatch(/DIFFERENT process/); // falls through to the pre-existing branch
  });

  it('says so plainly when attribution is UNCONFIRMED rather than asserting the marker is this run\'s', async () => {
    const b = await mockRefire(MARKER, { ...CRON_HELD_RUN, started_at: null });
    expect(String(b.note)).toMatch(/STAND DOWN/);
    expect(String(b.note)).toMatch(/Attribution UNCONFIRMED/);
    expect((b.in_flight_retriage as Record<string, unknown>).belongs_to_this_run).toBeNull();
  });

  it('no marker ⇒ the pre-existing refusal is untouched (null means "no refire", not "unknown")', async () => {
    const b = await mockRefire(null);
    expect(b.in_flight_retriage).toBeNull();
    expect(String(b.note)).toMatch(/DIFFERENT process/);
    expect(String(b.note)).not.toMatch(/AUTO-REFIRE/);
  });
});

/**
 * WI-6946: "release:checkpoint-run reports ok:true + launched:true + a ~55min ETA for a run
 * that aborts INCONCLUSIVE ('migrations-pending') seconds later — the caller waits out a
 * suite that is not running." Fix: preflight applyPendingMigrationsNow() BEFORE ever calling
 * launchDetachedCheckpoint, so a migration that fails to apply refuses immediately instead of
 * spawning a detached unit that will self-abort ~60s later with no way for the caller to know.
 */
describe('WI-6946: pending-migration preflight refuses BEFORE launching, not after', () => {
  it('a migration that fails to apply refuses immediately — launchDetachedCheckpoint is never called', async () => {
    vi.doMock('../../db-boot-migrate', () => ({
      applyPendingMigrationsNow: vi.fn(async () => ({
        applied: 0,
        failed: [{ file: '723-some-migration.sql', error: 'relation "x" does not exist' }],
      })),
    }));
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'x', argv: [], logPath: '/tmp/x.log' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).not.toHaveBeenCalled(); // never even attempted the launch
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'migrations-pending',
      pending: [{ file: '723-some-migration.sql', error: 'relation "x" does not exist' }],
    });
    expect(String(b.note)).toMatch(/NOT launched/);
    expect(String(b.note)).toContain('723-some-migration.sql');
    expect(String(b.note)).toMatch(/WI-6946/);
    // The reply must never claim a launch/ETA it didn't deliver — the exact defect this closes.
    expect(String(b.note)).not.toMatch(/~55 min/);
  });

  it('nothing pending (the common case, incl. a transient contention failure already retried inside applyPendingMigrationsNow) → launches normally', async () => {
    // Uses the file-level default mock (applied: 0, failed: []) — no override needed, proving
    // the ordinary path is unaffected by this preflight.
    const launchSpy = vi.fn(async () => ({ launched: true, unit: 'x', argv: [], logPath: '/tmp/x.log' }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: true, launched: true });
  });
});

describe('release:checkpoint-run', () => {
  it('launches the detached checkpoint and reports it (operator role)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const result = await tool.handler({}, MAKE_CTX());

    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(parse(result as never)).toMatchObject({ ok: true, launched: true, unit: 'papercup-green-checkpoint-manual' });
  });

  it('WI-5124: warns loudly in `note` when the quiet-cut excluded fresh commits (the "my fix was silently excluded" trap)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff my just-landed fix'],
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    // EI-18759622667757826: still warns, but as a PREDICTION — the assertion used to demand the
    // settled-fact wording ("EXCLUDED 1 commit"), which is the defect, not the contract.
    expect(String(b.note)).toMatch(/predicted exclusion: 1 commit/i);
    expect(String(b.note)).toContain('my just-landed fix');
  });

  // EI-18759622667757826: `excludedCommits` is resolved ~1-2s BEFORE the detached run re-resolves
  // its own candidate, and the quiet cut is a pure age test — so a commit seconds short of the
  // window ages in and IS judged. Reported as flat fact, that reading told the filer an expensive
  // healthy run was worthless, and the only lever that looks like a fix is killing it. The reply
  // must lead with the aging number and name waiting as the correct move.
  it('EI-18759622667757826: an exclusion about to age in is reported as a probably-pessimistic PREDICTION, not as fact', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff my just-landed fix'],
        excludedPaths: ['packages/operator-core/lib/x.ts'],
        excludedEligibility: [{ sha: 'fffffff', subject: 'my just-landed fix', eligibleInSec: 2 }],
        soonestEligibleInSec: 2,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const note = String(parse((await tool.handler({}, MAKE_CTX())) as never).note);

    expect(note).toMatch(/prediction only/i);
    expect(note).toMatch(/pessimistic/i);
    // The load-bearing correction: it says the run will very likely judge it after all.
    expect(note).toMatch(/very likely judge them after all/i);
    // …and never leaves "kill the run" as the reader's inference.
    expect(note).toMatch(/do not kill the run/i);
    expect(note).toMatch(/checkpoint:await/);
    // The old settled-fact grammar must not come back: it asserted an unmade decision.
    expect(note).not.toMatch(/they get the NEXT run/i);
  });

  it('EI-18759622667757826: an exclusion far from eligibility still reads as a prediction and never recommends killing', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: {
        candidate: 'aaaaaaa',
        tip: 'fffffff',
        quietCutApplied: true,
        quietCutSec: 240,
        excludedCommits: ['fffffff someone elses commit'],
        excludedPaths: ['apps/operator/x.ts'],
        excludedEligibility: [{ sha: 'fffffff', subject: 'someone elses commit', eligibleInSec: 180 }],
        soonestEligibleInSec: 180,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const note = String(parse((await tool.handler({}, MAKE_CTX())) as never).note);

    expect(note).toMatch(/predicted exclusion/i);
    expect(note).toMatch(/~180s/);
    expect(note).toMatch(/killing a live run is never the recovery/i);
    expect(note).not.toMatch(/prediction only/i);
  });

  it('WI-5124: no exclusion warning in `note` when the quiet-cut judged the tip directly', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      willJudge: { candidate: 'aaaaaaa', tip: 'aaaaaaa', quietCutApplied: false, quietCutSec: 240, excludedCommits: [] },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(true);
    expect(String(b.note)).not.toMatch(/EXCLUDED/i);
  });

  it('reports ok:false with the reason when the launch is refused', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual.log',
      reason: 'systemd-run exited 1 (a manual checkpoint may already be running)',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(b.ok).toBe(false);
    expect(String(b.note)).toMatch(/already running|not launched/i);
  });

  // EI-7426: firing the green verdict is verification-only + self-locked, and the persona tells
  // ANY red-fixing agent to fire it ("fix the reds → release:checkpoint-run → release:deploy").
  // It used to copy checkpoint-config's operator-config-write gate (correct there — it mutates
  // config; wrong here — this mutates nothing), so pipeline roles that greened the reds hit a
  // recurring structural tool-error. There is now no in-handler role gate; the invoke allowlist
  // (SU_ROLES + bee/release-fixer/release-manager) is the access control.
  it.each(['worker', 'debugger', 'cup', 'release-fixer'])(
    'fires the verdict for a non-operator red-fixing role (%s) — no operator-config-write gate (EI-7426)',
    async (role) => {
      const launchSpy = vi.fn(async () => ({
        launched: true,
        unit: 'papercup-green-checkpoint-manual',
        argv: [],
        logPath: '/tmp/papercup-green-checkpoint-manual.log',
      }));
      vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

      const { default: tool } = await import('./checkpoint-run');
      const b = parse((await tool.handler({}, MAKE_CTX(role))) as never);

      expect(launchSpy).toHaveBeenCalledTimes(1);
      expect(b).toMatchObject({ ok: true, launched: true });
    },
  );

  it('advertises the invoke allowlist to the red-fix cohort (mirrors release:deploy safe ops)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    const roles = (tool as { agentRoles?: readonly string[] }).agentRoles ?? [];
    // The specific pipeline roles the watchdog observed hitting the structural error, plus the
    // wider red-fix cohort, must be invoke-allowed (EI-7426).
    for (const r of ['worker', 'scoper', 'validator', 'reviewer', 'debugger', 'cup', 'release-fixer', 'release-manager']) {
      expect(roles).toContain(r);
    }
  });

  // WI-1562: the refuse-when-active path returns a STRUCTURED already_running reply instead of
  // a bare reason string, so a concurrent caller can tell "wait for it" from "try again".
  it('reports a structured already_running reply when a run is already active (WI-1562)', async () => {
    const launchSpy = vi.fn(async (opts: { force?: boolean }) => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: '2026-07-02T10:44:43Z',
        elapsed_sec: 8700, // OLD run (≫ REPLACE_STALE_MIN_AGE_SEC) — the EI-9672 wedged case
        eta_sec: 2100,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(launchSpy).toHaveBeenCalledWith({ force: undefined });
    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
      current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
      candidate_stale: true,
      quiet_cut_sec: 240,
      started_at: '2026-07-02T10:44:43Z',
      elapsed_sec: 8700,
      eta_sec: 2100,
    });
    expect(String(b.note)).toMatch(/replaceStale:true/);
  });

  // EI-11667 recurrence guard: a YOUNG stale run's note must NOT recommend replaceStale —
  // that recommendation is exactly what induced the 2026-07-13 fleet replace-storm (four sus
  // serially killing each other's runs; no verdict for 2h). Young-stale is NORMAL, not wedged.
  it('a YOUNG stale run gets a wait-for-verdict note, never a replaceStale recommendation (EI-11667)', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300, // 5 min — a healthy in-progress run on a busy tree
        eta_sec: 10500,
        replace_refused_young: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ replaceStale: true }, MAKE_CTX())) as never);

    expect(b).toMatchObject({ ok: false, already_running: true, candidate_stale: true, replace_refused_young: true, elapsed_sec: 300 });
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    expect(String(b.note)).toMatch(/Do NOT replace/i);
  });

  // EI-18757736867106199 — the ADVICE must not recommend what the ENFORCEMENT refuses.
  //
  // classifyReplaceRequest already refuses to stop a `delivering` run at any age
  // (EI-18757156963245979), but this tool's `note` was still computed from age ALONE. So for
  // an OLD + stale + delivering run — a run whose suite is done and which is re-triaging a
  // stale red, i.e. the gate self-healing — the tool said "Pass replaceStale:true to stop it"
  // while the launch path would refuse to do it. Observed 2026-07-27: told by the tool that
  // killing it was correct, a caller read the refusal as an obstacle and killed the run
  // out-of-band instead, discarding an auto-refire that was working.
  //
  // Pinned here: at ANY age, a delivering run's note must steer to waiting, never to
  // replaceStale — and the reply must expose WHY, so the refusal is self-explaining.
  it('EI-18757736867106199: an OLD delivering run is never told to replaceStale — the note matches the policy', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva',
        candidate: '98817077fd79af9dfee00076a1c6e90445d268af',
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: true,
        quiet_cut_sec: 240,
        started_at: new Date(Date.now() - 25 * 60_000).toISOString(),
        // Past the age line (the e4a93f8b shape: suite ran 1180s vs a 1200s threshold) — an
        // age-only rule calls this wedged and recommends the kill.
        elapsed_sec: 25 * 60,
        eta_sec: 1800,
        delivering: true,
        replace_refused_delivering: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ replaceStale: true }, MAKE_CTX())) as never);

    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      candidate_stale: true,
      delivering: true,
      replace_refused_delivering: true,
      // The policy verdict itself is now part of the reply, so the note can be checked
      // against it rather than the two drifting apart again.
      replace_allowed: false,
      replace_refused_reason: 'delivering',
    });
    // The regression: age said "wedged", so this string used to be the replaceStale nudge.
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    expect(String(b.note)).toMatch(/delivering/);
    expect(String(b.note)).toMatch(/self-healing|SUITE IS DONE/i);
    expect(String(b.note)).toContain('checkpoint:await');
  });

  // WI-5685: the manual unit can be idle while the hourly CRON tick still holds the shared
  // run-lock — this is the class that used to sail past the pre-launch check entirely
  // (launched:true, then a silent skipped-locked inside the detached process a moment later).
  // The reply's `note` must clearly say force/replaceStale cannot help, unlike the manual-vs-
  // manual collision notes above.
  it('WI-5685: a run held by the cron (not the manual unit) gets a distinct held_externally note that steers away from force/replaceStale', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
        candidate: null,
        current_head: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        current_candidate: 'aaaaaa77fd79af9dfee00076a1c6e90445d268af',
        candidate_stale: false,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300,
        eta_sec: 10500,
        held_externally: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(b).toMatchObject({ ok: false, already_running: true, held_externally: true, candidate: null });
    expect(String(b.note)).toMatch(/DIFFERENT process/);
    expect(String(b.note)).toMatch(/cannot free this slot/i);
    expect(String(b.note)).toContain('checkpoint:await');
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
    // EI-18695275971973546: candidate unresolved ⇒ the note must say so explicitly, rather
    // than silently letting the reader assume it matches current_candidate.
    expect(String(b.note)).toMatch(/could not be resolved/i);
  });

  // EI-18695275971973546: a wrong "this run can go green" broadcast happened because
  // `current_candidate` (a HYPOTHETICAL fresh-launch value) was misread as the in-flight run's
  // actual candidate while `candidate` sat null. Once `candidate` resolves (from the checkpoint
  // checkout's own HEAD), the note must name it explicitly and tell the reader to trust IT.
  it('EI-18695275971973546: a resolved held_externally candidate is named explicitly in the note, distinct from current_candidate', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
      reason: 'already_running',
      alreadyRunning: {
        active: true,
        unit: 'papercup-green-checkpoint-manual-1fxzuva (idle — a DIFFERENT process holds the shared run-lock, likely the hourly cron)',
        candidate: 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        current_head: '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        current_candidate: '6ea7bdad60bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        candidate_stale: false,
        started_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        elapsed_sec: 300,
        eta_sec: 10500,
        held_externally: true,
      },
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);

    expect(b).toMatchObject({
      ok: false,
      already_running: true,
      held_externally: true,
      candidate: 'a0d9300182aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(String(b.note)).toContain('a0d9300182aa');
    expect(String(b.note)).toMatch(/verify your fix against THAT sha/i);
    expect(String(b.note)).not.toMatch(/Pass replaceStale:true/);
  });

  it('passes force:true through to the launch primitive', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: true,
      unit: 'papercup-green-checkpoint-manual-1fxzuva',
      argv: [],
      logPath: '/tmp/papercup-green-checkpoint-manual-1fxzuva.log',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
    }));

    const { default: tool } = await import('./checkpoint-run');
    await tool.handler({ force: true }, MAKE_CTX());

    expect(launchSpy).toHaveBeenCalledWith({ force: true });
  });

  /* ----------------------------------------------------------------------- *
   * P-004 (EI-18752644493166307) — the containment answer, in the reply.
   *
   * The filer burned two gate runs judging candidates without their fix, and had
   * restated the correct rule to the owner an hour earlier. That is the evidence
   * that prose is the wrong layer: a rule you must recall at exactly the right
   * instant only fires for someone who already knows. It has to be in the return
   * value, at the moment of the mistake.
   * ----------------------------------------------------------------------- */
  const LAUNCHED = {
    launched: true,
    unit: 'papercup-green-checkpoint-manual',
    argv: [],
    logPath: '/tmp/papercup-green-checkpoint-manual.log',
    willJudge: {
      candidate: 'aaaaaaa',
      tip: 'fffffff',
      quietCutApplied: true,
      quietCutSec: 240,
      excludedCommits: ['fffffff my just-landed fix'],
      excludedPaths: ['packages/operator-core/lib/mine.ts'],
    },
  };

  const mockWith = (containment: unknown) => {
    const launchSpy = vi.fn(async () => LAUNCHED);
    const containmentSpy = vi.fn(async () => containment);
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: containmentSpy,
      // EI-20025784115349280: the pre-launch gate calls the REAL containment (an internal
      // module binding a doMock cannot reach), so without this a `paths` test forks git and
      // systemctl against the live repo — non-deterministic, and the verdict would depend on
      // whatever the fleet had just committed. These cases are about the POST-launch warning;
      // pin the gate open so they keep testing exactly that.
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
    }));
    return { launchSpy, containmentSpy };
  };

  it('reports callerEditsInCandidate and leads the note with the hard warning', async () => {
    const { containmentSpy } = mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      source: 'caller-supplied',
      included: [],
      missing: ['packages/operator-core/lib/mine.ts'],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: '⚠ THIS RUN WILL NOT SEE 1 of your file(s). A RED from it is NOT evidence your change failed.',
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['packages/operator-core/lib/mine.ts'] }, MAKE_CTX())) as never);

    // The caller's declared paths reach the check against the commit that will be judged.
    expect(containmentSpy).toHaveBeenCalledWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      paths: ['packages/operator-core/lib/mine.ts'],
    });
    expect(b.callerEditsInCandidate).toMatchObject({ missing: ['packages/operator-core/lib/mine.ts'] });
    expect(String(b.note)).toMatch(/NOT evidence your change failed/);
  });

  /**
   * The old warning ended at "if your fix is among them" and listed SHAS — the one space
   * the reader has no information about. When containment cannot resolve it, the fallback
   * must at least answer in PATH space, which the caller CAN match against its own edits.
   */
  it('falls back to naming the FILES the excluded commits touch, not just the shas', async () => {
    mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'fffffff',
      source: 'inferred-uncommitted',
      included: [],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({}, MAKE_CTX())) as never);
    expect(String(b.note)).toMatch(/Those commits touch: packages\/operator-core\/lib\/mine\.ts/);
    expect(String(b.note)).toMatch(/not evidence your change failed/i);
    expect(String(b.note)).not.toMatch(/if your fix is among them/);
  });

  it('confirms containment positively when the candidate DOES carry the files', async () => {
    mockWith({
      candidateSha: 'aaaaaaa',
      tipSha: 'aaaaaaa',
      source: 'caller-supplied',
      included: ['packages/operator-core/lib/mine.ts'],
      missing: [],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: null,
    });

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['packages/operator-core/lib/mine.ts'] }, MAKE_CTX())) as never);
    // A caller told "your file is in there" can trust a red as a real red — which is the
    // other half of the fix, and the half that stops a needless re-fire.
    expect(String(b.note)).toMatch(/real verdict on your change/);
    // The generic exclusion notice is kept but DOWNGRADED — it is provably not about the
    // caller's files, so it must not read as a warning that shadows the positive answer.
    expect(String(b.note)).toMatch(/none of the files you named/);
    // EI-18759622667757826: assert it carries NO warning marker at all. The old assertion
    // pinned one literal string ("⚠ quiet-cut EXCLUDED") that no longer exists, so it had
    // silently degraded into a test that could never fail.
    expect(String(b.note)).not.toMatch(/⚠/);
  });

  it('answers containment on the already_running path too — that verdict is the one landing', async () => {
    const launchSpy = vi.fn(async () => ({
      launched: false,
      unit: 'papercup-green-checkpoint-manual',
      argv: [],
      logPath: '/tmp/x.log',
      reason: 'already_running',
      alreadyRunning: { active: true, unit: 'u', candidate: 'inflight1', current_head: 'tip1' },
    }));
    const containmentSpy = vi.fn(async () => ({
      candidateSha: 'inflight1',
      tipSha: 'tip1',
      source: 'caller-supplied' as const,
      included: [],
      missing: ['mine.ts'],
      unknown: [],
      paths: [],
      excludedCommitsTouchingYourFiles: [],
      testImplSplitRisk: { detected: false, includedTests: [], missingImpl: [] },
      warning: '⚠ the in-flight run cannot see mine.ts',
    }));
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: containmentSpy,
      assessPreLaunchExclusion: PRELAUNCH_OPEN,
    }));

    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: ['mine.ts'] }, MAKE_CTX())) as never);
    // Checked against the IN-FLIGHT candidate, never the hypothetical fresh one.
    expect(containmentSpy).toHaveBeenCalledWith({ candidateSha: 'inflight1', tipSha: 'tip1', paths: ['mine.ts'] });
    expect(b.containment_warning).toMatch(/cannot see mine\.ts/);
  });
});

// EI-18773280958875269: a doc/prompt that quotes this tool's emitted wording has NO
// drift guard of its own — release-fixer.md told agents to look for a
// `⚠ quiet-cut EXCLUDED` banner this file stopped emitting (EI-18759622667757826 reworded
// it to `⚠ PREDICTED exclusion: …` / `⚠ PREDICTION ONLY — …`). A stale quote reads as
// "nothing was excluded" to a release-fixer agent following the prompt literally, on the
// release-gate path. This is the POSITIVE-assertion counterpart of the vacuous-negative
// lint's own motivating case (scripts/check-vacuous-negative-assertions.mjs) — pin the
// prompt's quoted banner prefixes against the literals this file actually builds them
// from, so rewording one without the other fails loudly instead of drifting silently.
describe('release-fixer.md prompt banners stay in sync with this file', () => {
  const PROMPT_PATH = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/release-fixer.md',
  );

  it('quotes the current PREDICTED-exclusion banner prefixes, not a retired one', () => {
    const prompt = readFileSync(PROMPT_PATH, 'utf8');
    // The two live prefixes checkpoint-run.ts builds the warning from (see the
    // ` ⚠ PREDICTION ONLY — …` / ` ⚠ PREDICTED exclusion: …` template literals above).
    expect(prompt).toContain('⚠ PREDICTED exclusion:');
    expect(prompt).toContain('⚠ PREDICTION ONLY — and this one is probably PESSIMISTIC');
    // The retired banner this class was filed over must not have crept back in — a
    // literal reappearance here means someone quoted the OLD wording again.
    expect(prompt).not.toMatch(/⚠ quiet-cut EXCLUDED/);
  });
});

/**
 * state-plane-adoption-2026-08-02 P-002 / D-001. This verb's `candidate` is the most
 * drift-prone value in the repo — a run re-candidates onto tip mid-flight — so a reply
 * that means "a verdict is coming" must point at the plane for a RE-READ rather than
 * leaving the caller to transcribe the field.
 */
describe('release:checkpoint-run routes to the state plane (P-002)', () => {
  // Same per-test dynamic import every other test here uses (vi.resetModules/doMock).
  const load = async () => {
    const { default: tool } = await import('./checkpoint-run');
    const { resolveSeeAlso } = await import('@papercusp/agent-mcp');
    const ptrs = (text: string) =>
      resolveSeeAlso(tool.guidance?.seeAlso, { content: [{ type: 'text' as const, text }] } as never, {}, {});
    const cells = (text: string) =>
      ptrs(text)
        .filter((p) => p.tool.startsWith('state:'))
        .map((p) => `${p.tool} ${p.selector ?? ''}`);
    return { ptrs, cells };
  };

  it('points at the candidate cell + the verdict subscription when a run is already in flight', async () => {
    const { cells } = await load();
    const p = cells(JSON.stringify({ ok: false, already_running: true, candidate: 'abc123' }));
    expect(p.some((s) => s.startsWith('state:read') && s.includes('gate.greenCheckpoint.candidate'))).toBe(true);
    expect(p.some((s) => s.startsWith('state:subscribe') && s.includes('gate.greenCheckpoint.verdict'))).toBe(true);
  });

  it('does the same when THIS call launched the run', async () => {
    const { cells } = await load();
    expect(cells(JSON.stringify({ ok: true, launched: true }))).toHaveLength(2);
  });

  /** No verdict coming ⇒ no re-read advice; the pointer must not become unconditional noise. */
  it('stays silent when nothing was launched and nothing is running', async () => {
    const { cells } = await load();
    expect(cells(JSON.stringify({ ok: false, launched: false, reason: 'migrations-pending' }))).toHaveLength(0);
  });

  /** The silent-no-op trap: a JSON-only gate never fires on a TOON-rendered envelope. */
  it('still fires when the envelope is TOON, not JSON', async () => {
    const { cells } = await load();
    expect(cells('already_running: true\ncandidate: abc123')).toHaveLength(2);
  });

  it('keeps the pre-existing deploy/config pointers', async () => {
    const { ptrs } = await load();
    const tools = ptrs(JSON.stringify({ launched: true })).map((x) => x.tool);
    for (const name of ['release:deploy', 'release:checkpoint-config']) {
      expect(tools.some((t) => t.startsWith(name))).toBe(true);
    }
  });
});

/**
 * EI-20025784115349280 — the gate must be proved by the SPAWN, not by the reply.
 *
 * A tool that returns a refusal payload while still creating the systemd unit has fixed
 * nothing: the ~55min suite is running either way, and the caller is merely better informed
 * about a slot it can no longer get back. So the load-bearing assertion in every case below
 * is whether `launchDetachedCheckpoint` — the only path to a unit — was called at all.
 */
describe('pre-launch exclusion gate: the spawn, not the reply (EI-20025784115349280)', () => {
  const MINE = 'packages/operator-core/lib/mine.ts';
  const LAUNCHED_OK = {
    launched: true,
    unit: 'papercup-green-checkpoint-manual',
    argv: [],
    logPath: '/tmp/papercup-green-checkpoint-manual.log',
  };
  const REFUSAL = {
    refuse: true,
    proceedReason: null,
    candidate: 'aaaaaaaaaaaa',
    tip: 'ffffffffffff',
    quietCutSec: 240,
    blockedPaths: [{ path: MINE, commits: ['bbb1111 my just-landed fix'], eligibleInSec: 120 }],
    waitSec: 120,
  };

  const mockLaunch = (over: Record<string, unknown> = {}) => {
    const launchSpy = vi.fn(async () => LAUNCHED_OK);
    vi.doMock('../../release-checkpoint-launch', async (orig) => ({
      ...(await orig()),
      launchDetachedCheckpoint: launchSpy,
      checkpointCandidateContainment: NO_CONTAINMENT,
      ...over,
    }));
    return launchSpy;
  };

  it('creates NO systemd unit when the run would exclude the declared paths', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);

    // THE assertion this whole change exists for: the gate slot was never taken.
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'would_exclude_declared_paths',
      wait_sec: 120,
      blocked_paths: [{ path: MINE, eligibleInSec: 120 }],
    });
    // A refusal without a stated way forward gets routed around rather than followed.
    expect(String(b.note)).toMatch(/waitForEligibility:true/);
    expect(String(b.note)).toMatch(/force:true/);
  });

  it('CONTROL: launches normally when the gate does not fire', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => ({ ...REFUSAL, refuse: false, proceedReason: 'declared-paths-in-candidate' })) });
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE] }, MAKE_CTX())) as never);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b.ok).toBe(true);
  });

  it('force:true bypasses the gate and launches', async () => {
    // Deliberately NOT mocking the assessor: under `force` the real one short-circuits before
    // it touches git or systemd, so this exercises the actual wiring rather than a stand-in.
    const launchSpy = mockLaunch();
    const { default: tool } = await import('./checkpoint-run');
    const b = parse((await tool.handler({ paths: [MINE], force: true }, MAKE_CTX())) as never);
    expect(launchSpy).toHaveBeenCalledTimes(1);
    expect(b.ok).toBe(true);
    expect(b.reason).toBeUndefined();
  });

  it('EI-20208253097914491: stamps a condition_claimed refusal before returning', async () => {
    const launchSpy = mockLaunch();
    const ownership = {
      eventKey: 'gate-red-streak:papercusp',
      workItem: 'WI-38026',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-live-holder',
      takenAt: '2026-08-12T02:00:00.000Z',
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: { recent: [], total: 0 },
    };
    vi.doMock('../../coord/gate-ownership', () => ({
      readGateOwnership: vi.fn(async () => ownership),
      shouldStandDownForLivePeer: vi.fn(() => true),
      ownershipNeedsLivenessConfirmation: vi.fn(() => null),
    }));

    const { default: tool } = await import('./checkpoint-run');
    const metadata = vi.fn();
    const ctx = {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      role: 'operator',
      uiClientId: 'su-caller',
      metadata,
    } as never;
    const b = parse((await tool.handler({ reason: 'gate red' }, ctx)) as never);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: false, launched: false, reason: 'condition_claimed' });
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata).toHaveBeenCalledWith({
      standDown: 'condition_claimed',
      standDownWorkItem: 'WI-38026',
      standDownTakenBy: 'su-live-holder',
      standDownHolderSessionState: 'live',
      fireReason: 'gate red',
    });
  });

  it('waitForEligibility returns a durable receipt without sleeping or spawning in the request', async () => {
    const scheduleSpy = vi.fn(async () => ({
      pendingId: 'pending-1',
      workflowId: 'checkpoint-eligibility:pending-1',
      completionEvents: [
        'release:green:papercusp',
        'green-checkpoint:red:papercusp',
        'green-checkpoint:inconclusive:papercusp',
      ],
    }));
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => REFUSAL),
      scheduleCheckpointEligibilityWait: scheduleSpy,
    });
    const { default: tool } = await import('./checkpoint-run');
    const started = Date.now();
    const b = parse((await tool.handler({ paths: [MINE], waitForEligibility: true }, MAKE_CTX())) as never);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [MINE],
        waitSec: 120,
        pendingId: expect.any(String),
      }),
    );
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: true,
      launched: false,
      pending: true,
      reason: 'waiting_for_eligibility',
      pending_id: 'pending-1',
      workflow_id: 'checkpoint-eligibility:pending-1',
      completion_events: ['release:green:papercusp', 'green-checkpoint:red:papercusp', 'green-checkpoint:inconclusive:papercusp'],
    });
    expect(String(b.note)).toMatch(/durable eligibility waiter/);
  });

  it('waitForEligibility fails closed when the durable runner is unavailable, without a request-side sleep', async () => {
    const scheduleSpy = vi.fn(async () => {
      throw new Error('DBOS is not installed');
    });
    const launchSpy = mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => REFUSAL),
      scheduleCheckpointEligibilityWait: scheduleSpy,
    });
    const { default: tool } = await import('./checkpoint-run');
    const started = Date.now();
    const b = parse((await tool.handler({ paths: [MINE], waitForEligibility: true }, MAKE_CTX())) as never);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(launchSpy).not.toHaveBeenCalled();
    expect(b).toMatchObject({
      ok: false,
      launched: false,
      reason: 'wait_for_eligibility_unavailable',
    });
    expect(String(b.note)).toMatch(/no MCP sleep was attempted/);
  });

  /**
   * WI-37618. The refusal above is returned to the CALLER and stored nowhere else:
   * `tool_invocations` keeps only transport metadata and `output_ref` is a reference, not a
   * body. So in the ledger a refusal looked identical to a call that spent a ~55min suite, and
   * a FALSE refusal — the one failure mode that would wedge the fleet's only manual verdict
   * lever — left nothing behind to audit.
   *
   * These assert the LEDGER STAMP specifically, not the reply. The reply is what the caller can
   * already see; the stamp is what anyone can see AFTERWARDS. `MAKE_CTX` deliberately has no
   * `metadata`, which is why the handler optional-chains it and why these build their own ctx.
   */
  const MAKE_CTX_META = () => {
    const metadata = vi.fn();
    return {
      ctx: {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        role: 'operator',
        metadata,
      } as never,
      metadata,
    };
  };

  it('stamps the REFUSAL into ctx.metadata, so a false refusal is auditable after the fact', async () => {
    const launchSpy = mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, ctx);

    expect(launchSpy).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledTimes(1);
    // Enough to re-derive the decision later: which paths were held back, against which
    // candidate, and for how long. The commits themselves stay recoverable from the candidate.
    expect(metadata.mock.calls[0][0]).toMatchObject({
      preLaunchExclusion: 'refused',
      preLaunchCandidate: 'aaaaaaaaaaaa',
      preLaunchTip: 'ffffffffffff',
      preLaunchWaitSec: 120,
      preLaunchBlockedPaths: [{ path: MINE, eligibleInSec: 120 }],
    });
  });

  it('stamps a PASS with its proceedReason, so the refusal rate has a denominator', async () => {
    mockLaunch({
      assessPreLaunchExclusion: vi.fn(async () => ({
        ...REFUSAL,
        refuse: false,
        proceedReason: 'exclusion-undecidable',
      })),
    });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, ctx);

    const stamped = metadata.mock.calls[0][0] as Record<string, unknown>;
    // The defect was that these two were the SAME observation. They must never be again.
    expect(stamped.preLaunchExclusion).toBe('passed');
    // And WHICH fail-open path: "could not assess" is not "assessed and allowed", and a
    // bare `passed` would rebuild exactly the ambiguity this exists to remove.
    expect(stamped.preLaunchProceedReason).toBe('exclusion-undecidable');
    // A pass carries no blocked-path detail — that would imply a refusal that never happened.
    expect(stamped).not.toHaveProperty('preLaunchBlockedPaths');
  });

  // ─── EI-20031402866608444: `reason` is ACCEPTED and recorded ───────────────────────────────
  // It was undeclared, and the published schema is additionalProperties:false, so passing it was
  // an invalid_input that launched NOTHING: 19 of 22 rejections in 14 days (~11% of all calls to
  // this verb), 6 distinct agents on 2026-08-09 alone, every case a retry-without-it seconds
  // later, mid-incident, on the fleet's only manual verdict lever.
  //
  // ⚠ MEASURED, not assumed: this args schema is STRICT — an undeclared key is REJECTED here, at
  // safeParse, not merely stripped. (I first wrote the control below the other way round, on the
  // usual zod default of silently dropping unknown keys, and it failed: `success` came back
  // false. So the invalid_input the 19 rejections hit originates at THIS schema, not only at the
  // published additionalProperties:false contract.) That is what makes the assertions below real
  // guards rather than vacuous ones — had unknown keys been stripped instead, a bare
  // `.success === true` would pass just as happily against a schema that never declared `reason`,
  // so these still assert the parsed OUTPUT as well.

  const REASON = 'gate RED 3x / ~2h, main frozen, no run in flight';

  it('EI-20031402866608444: a `reason` SURVIVES the args schema (it used to be rejected outright)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    const parsed = tool.args.safeParse({ reason: REASON });
    if (!parsed.success) throw new Error('reason was REJECTED by the args schema — the original defect');
    expect((parsed.data as { reason?: string }).reason).toBe(REASON);
  });

  it('EI-20031402866608444: CONTROL — an UNDECLARED arg is still REJECTED, reproducing the original defect', async () => {
    const { default: tool } = await import('./checkpoint-run');
    // This is the defect itself, held in place as a control: an arg this schema does not declare
    // fails to parse, which is precisely what `reason` used to do. It proves (a) the schema is
    // still strict — accepting `reason` did not quietly open the tool to anything — and (b) the
    // test above is falsifiable, since deleting the `reason` field would make it fail exactly
    // like this.
    expect(tool.args.safeParse({ definitelyNotAnArg: 'x' }).success).toBe(false);
  });

  it('EI-20031402866608444: never rejects a reason for terseness or length (softText, not hardText)', async () => {
    const { default: tool } = await import('./checkpoint-run');
    // This verb's whole defect was REJECTING callers; a length/min rule would rebuild it in
    // miniature. hardText(LIMITS.SHORT_TITLE, { min: 8 }) — the sibling release:deploy shape —
    // would fail BOTH of these.
    const terse = tool.args.safeParse({ reason: 'red' });
    expect(terse.success && (terse.data as { reason?: string }).reason).toBe('red');
    const huge = tool.args.safeParse({ reason: 'x'.repeat(5000) });
    expect(huge.success && (huge.data as { reason?: string }).reason).toHaveLength(5000);
  });

  it('EI-20031402866608444: stamps the reason as fireReason WITHOUT clobbering the exclusion keys', async () => {
    mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');
    const { ctx, metadata } = MAKE_CTX_META();
    await tool.handler({ paths: [MINE], reason: REASON }, ctx);

    // ONE call, carrying BOTH. The seam is overwrite-not-merge (dispatch-stack.ts:550, "last
    // write wins"), so stamping the reason from a SECOND ctx.metadata() call would wipe every
    // preLaunchExclusion key WI-37618 added. This is the guard on that.
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(metadata.mock.calls[0][0]).toMatchObject({
      fireReason: REASON,
      preLaunchExclusion: 'refused',
      preLaunchCandidate: 'aaaaaaaaaaaa',
      preLaunchBlockedPaths: [{ path: MINE, eligibleInSec: 120 }],
    });
  });

  it('EI-20031402866608444: omits fireReason entirely when no reason was given, and clamps a huge one', async () => {
    mockLaunch({ assessPreLaunchExclusion: vi.fn(async () => REFUSAL) });
    const { default: tool } = await import('./checkpoint-run');

    const bare = MAKE_CTX_META();
    await tool.handler({ paths: [MINE] }, bare.ctx);
    // Absent rather than null/'' — so `metadata_json ? 'fireReason'` cleanly separates the calls
    // that actually justified themselves from the ones that did not.
    expect(bare.metadata.mock.calls[0][0]).not.toHaveProperty('fireReason');

    const big = MAKE_CTX_META();
    await tool.handler({ paths: [MINE], reason: 'y'.repeat(5000) }, big.ctx);
    // Accepted at the schema, bounded at the stamp — the softText/clampText contract.
    expect((big.metadata.mock.calls[0][0] as { fireReason: string }).fireReason).toHaveLength(1000);
  });
});
