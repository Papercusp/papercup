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
afterEach(() => vi.doUnmock('../../release-checkpoint-launch'));

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
