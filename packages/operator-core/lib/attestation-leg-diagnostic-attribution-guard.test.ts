/**
 * attestation-leg-diagnostic-attribution-guard.test.ts — regression guard for
 * EI-18737225233571148.
 *
 * THE BUG (observed live, gate run 133957 on 2026-07-26). The
 * attestation_unattested_device leg of the live-federation matrix explained its own FAIL
 * from `reasons` — a hive-wide `SELECT ... WHERE reason LIKE 'receipt-apply:%' ORDER BY
 * updated_at DESC LIMIT 3` — and, on merely SEEING responder_mismatch in that window,
 * printed "RIG/ENVIRONMENTAL, not a fresh feature defect ... Do not open a fresh
 * investigation off this signature alone".
 *
 * That verdict was false, and it was load-bearing. LEG3 (attestation_membership, order 60)
 * emits ONE receipt with responder=a_gh_id and bumps responder_mismatch 0->2. The four
 * invasive scenarios that run BETWEEN LEG3 and this leg (restart_durability(80) /
 * reconnect_catchup(85) / replication_soak(87) / revocation_kcut(90); restart_settle_barrier
 * took 604s that run) then retried that SAME receipt until the counter read 10 — every retry
 * logged with the identical responder=279242982, none carrying this leg's own responder. So
 * responder_mismatch was simply the most-recently-updated reason at scoring time while THIS
 * leg's probe had caused no refusal at all. The gate reds on any FAIL, so the leg's 3/3
 * deterministic red blocked WI-5064 (standing local release gate FIRST GREEN) outright —
 * while its own message told every reader the cause was environmental and not to look.
 *
 * Two things made it survive: (1) the leg's counter ASSERT had already been hardened against
 * exactly this stale-rebump hazard (scoped to the single reason this leg causes — see the
 * WI-5779 comment in the script), but the hardening was never applied to the EXPLANATION
 * added later; (2) "environmental" was asserted about a byte-identical 3/3 signature, which
 * is not what intermittent looks like.
 *
 * THE FIX. Snapshot the FULL per-reason counter vector before the probe and diff it after, so
 * the diagnostic can cite only reasons that moved during this leg's own window — and when
 * NOTHING moved, say the true and far more useful thing: the receipt never reached the apply
 * path at all (a refused receipt always bumps some reason).
 *
 * WHAT THIS GUARD IS FOR. The class here is "a diagnostic explains a failure using evidence
 * it cannot attribute to itself, and suppresses the investigation that would catch it". A
 * guard that only pinned the current wording would rot immediately; these legs instead pin
 * the ATTRIBUTION CONTRACT (diff-based, unbounded, stably ordered, captured before the probe)
 * and the absence of a blanket do-not-investigate directive.
 *
 * STATIC leg: pins the attribution contract in the shipping script.
 * BEHAVIORAL leg: evals the REAL diff computation out of the shipping script under bash and
 * replays the actual 133957 counter vectors through it, asserting it reports "nothing moved"
 * on the exact data that previously produced the false environmental verdict.
 *
 *   cd packages/operator-core && npx vitest run lib/attestation-leg-diagnostic-attribution-guard.test.ts
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCN_REL = join('papercusp-desktop', 'bin', 'lib', 'scenarios', 'b9-attestation.sh');

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, SCN_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the repo root (no ${SCN_REL} above this test)`);
}

const ROOT = repoRoot();
const SCN_PATH = join(ROOT, SCN_REL);
const scn = readFileSync(SCN_PATH, 'utf8');

/**
 * The unattested-device scenario body — the only part of the file this guard governs.
 *
 * ANCHOR ON THE CORE, NOT THE WRAPPER (WI-5064 follow-up). The shipping leg is now two
 * functions: `_scn_attestation_unattested_device_core()` — the ~200-line implementation this
 * guard actually governs — plus a thin `scn_attestation_unattested_device()` wrapper that
 * guarantees B's device_attestations are RESTORED on every exit path (revocation_kcut(90)
 * reads the column this leg empties). A plain `indexOf('scn_attestation_unattested_device()')`
 * finds the WRAPPER, which is 5 lines long, so this guard silently degraded to scanning a stub
 * and 10 of its 12 assertions went red without a single contract regression. Prefer the core;
 * fall back to the undecorated name for a pre-wrapper file.
 */
function unattestedLegBody(): string {
  const core = scn.indexOf('_scn_attestation_unattested_device_core()');
  const start = core >= 0 ? core : scn.indexOf('scn_attestation_unattested_device()');
  expect(start, 'the unattested-device leg (core or undecorated) must exist').toBeGreaterThan(-1);
  const end = scn.indexOf('matrix_register attestation_unattested_device', start);
  expect(end, 'the leg must still be registered after its definition').toBeGreaterThan(start);
  const body = scn.slice(start, end);
  // A TEXT-EXTRACTION guard must fail LOUDLY when it stops finding the thing it governs —
  // scanning the wrong (or an emptied) region is exactly how this guard reported ten false
  // regressions. The real leg is ~200 lines; anything close to a stub means the implementation
  // moved and the anchors above need updating, NOT that the contract broke.
  expect(
    body.length,
    'extracted leg body is implausibly small — the anchors are pointing at a stub/wrapper, not the implementation',
  ).toBeGreaterThan(2000);
  return body;
}

/** Verdict branches that gate on `reasons` (the recency window) instead of the diffed set. */
function offendingReasonBranches(body: string): string[] {
  return body
    .split('\n')
    .filter((l) => /^\s*(if|elif)\b/.test(l) && /\breasons\b/.test(l))
    .filter(
      (l) =>
        !l.includes('reasons_moved') && !l.includes('reasons_before') && !l.includes('reasons_after'),
    )
    .map((l) => l.trim());
}

/** Verdict branches that DO gate on the diffed set. */
function reasonBranchCount(body: string): number {
  return body
    .split('\n')
    .filter((l) => /^\s*(if|elif)\b/.test(l) && /reasons_(moved|before|after)/.test(l)).length;
}

describe('attestation_unattested_device diagnostic attribution (EI-18737225233571148)', () => {
  describe('STATIC — the attribution contract', () => {
    it('captures a before AND after per-reason vector, and diffs them into reasons_moved', () => {
      const body = unattestedLegBody();
      expect(body, 'a pre-probe snapshot must exist').toContain('reasons_before=');
      expect(body, 'a post-probe snapshot must exist').toContain('reasons_after=');
      expect(body, 'the two must be diffed into a moved-set').toContain('reasons_moved=');
    });

    it('snapshots are stably ordered and UNBOUNDED — a recency LIMIT cannot express a set', () => {
      const body = unattestedLegBody();
      for (const v of ['reasons_before', 'reasons_after']) {
        const line = body.split('\n').find((l) => l.trimStart().startsWith(`${v}=`));
        expect(line, `${v} must be assigned in the leg`).toBeTruthy();
        // ORDER BY reason (a stable set), never ORDER BY updated_at (a recency window).
        expect(line, `${v} must order by reason, not recency`).toContain('ORDER BY reason');
        expect(line, `${v} must not order by updated_at`).not.toContain('updated_at');
        // A LIMIT would let a reason fall out of the before-set and read as "new" after.
        expect(line, `${v} must not be LIMITed`).not.toMatch(/\bLIMIT\b/);
      }
    });

    it('the before-snapshot is taken BEFORE the probe insert (else the diff is meaningless)', () => {
      const body = unattestedLegBody();
      const snapshot = body.indexOf('reasons_before=');
      const insert = body.indexOf('INSERT INTO harness_shared.p2p_receipts');
      expect(snapshot, 'reasons_before must be assigned').toBeGreaterThan(-1);
      expect(insert, 'the probe INSERT must exist').toBeGreaterThan(-1);
      expect(snapshot, 'reasons_before must precede the probe INSERT').toBeLessThan(insert);
    });

    it('no verdict BRANCH keys off the recency-limited `reasons` variable', () => {
      expect(offendingReasonBranches(unattestedLegBody())).toEqual([]);
      expect(
        reasonBranchCount(unattestedLegBody()),
        'at least one branch must gate on the diffed set',
      ).toBeGreaterThan(0);
    });

    // SELF-PROOF. A static guard that only ever sees the fixed source cannot show it would
    // have CAUGHT the bug — and an always-green guard silently stops guarding (the same
    // failure mode this file exists to document). So feed the detector the historical broken
    // form and assert it reports the offending line. If someone loosens the scan above, this
    // fails loudly instead of the guard quietly going blind.
    it('SELF-PROOF: the scan flags the historical pre-fix branch', () => {
      const historical = [
        '  rem_on_a="$(drv_psql a "SELECT count(*) ...")"',
        `  reasons="$(drv_psql a "SELECT reason||'='||count ... ORDER BY updated_at DESC LIMIT 3;")"`,
        `  if [ "$rem_on_a" = 0 ] && printf '%s' "$reasons" | grep -q '^receipt-apply:responder_mismatch='; then`,
        '    echo "attestation(unattested-device) FAIL — RIG/ENVIRONMENTAL, not a fresh feature defect: ..."',
        '    return 1',
        '  fi',
      ].join('\n');
      const offenders = offendingReasonBranches(historical);
      expect(offenders.length, 'the historical branch must be flagged').toBe(1);
      expect(offenders[0]).toContain('grep -q');
    });

    it('reports the never-reached-apply-path case explicitly when nothing moved', () => {
      const body = unattestedLegBody();
      const emptyBranch = body
        .split('\n')
        .some((l) => /^\s*if\b/.test(l) && l.includes('reasons_moved') && l.includes('-z'));
      expect(emptyBranch, 'an empty moved-set must have its own branch').toBe(true);
      expect(body).toMatch(/NEVER REACHED THE APPLY PATH/);
    });

    it('EMITS no blanket do-not-investigate directive', () => {
      // Scoped to what the leg PRINTS, not what it documents: the comments deliberately quote
      // the historical message to explain the bug, and a guard that banned the words outright
      // would fire on that documentation — a false positive that would train the next reader
      // to delete the explanation rather than keep the fix.
      const emitted = unattestedLegBody()
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
      // The precise sentence that suppressed the WI-5064 investigation for hours.
      expect(emitted).not.toContain('Do not open a fresh investigation off this signature alone');
      // And it must not assert environmental causation as settled fact in a FAIL verdict.
      expect(emitted).not.toContain('RIG/ENVIRONMENTAL, not a fresh feature defect');
    });
  });

  describe('BEHAVIORAL — the real diff, on the real 133957 data', () => {
    /** Eval the shipping diff loop against supplied vectors; echo the moved-set. */
    function movedSet(before: string, after: string): string {
      const body = unattestedLegBody();
      const start = body.indexOf('reasons_moved=""');
      expect(start, 'the diff loop must exist').toBeGreaterThan(-1);
      const doneIdx = body.indexOf('\n  done', start);
      expect(doneIdx, 'the diff loop must terminate').toBeGreaterThan(start);
      // `local` is only legal inside a function — neutralise it to eval the loop standalone.
      // Drop bare `local x` DECLARATIONS outright (leaving the bare name behind would make
      // bash try to EXECUTE it), and strip the keyword from `local x=...` assignments.
      const loop = body
        .slice(start, doneIdx + '\n  done'.length)
        .replace(/^[ \t]*local[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*$\n?/gm, '')
        .replace(/^([ \t]*)local[ \t]+/gm, '$1');
      const script = [
        'set -u',
        `reasons_before=${JSON.stringify(before)}`,
        `reasons_after=${JSON.stringify(after)}`,
        loop,
        'printf "%s" "$reasons_moved"',
      ].join('\n');
      return execFileSync('bash', ['-c', script], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' }).trim();
    }

    it('THE REGRESSION: the exact 133957 vectors report NOTHING moved', () => {
      // Run 133957: LEG3 bumped responder_mismatch to 2, the invasive scenarios retried it to
      // 10 BEFORE this leg's snapshot, and identity_unresolved never moved. The old code saw
      // responder_mismatch in the recency window and declared the failure environmental.
      const before = 'receipt-apply:responder_mismatch=10 ';
      const after = 'receipt-apply:responder_mismatch=10 ';
      expect(movedSet(before, after)).toBe('');
    });

    it('a stale re-bump BEFORE the snapshot is not attributed to this leg', () => {
      // The counter climbing 2 -> 10 is invisible to the diff precisely because it happened
      // before the probe: that is the whole point of snapshotting late.
      const before = 'receipt-apply:responder_mismatch=10 ';
      const after = 'receipt-apply:responder_mismatch=10 ';
      expect(movedSet(before, after)).not.toContain('responder_mismatch');
    });

    it("this leg's own target signal IS attributed when it genuinely fires", () => {
      const before = 'receipt-apply:responder_mismatch=10 ';
      const after = 'receipt-apply:identity_unresolved=1 receipt-apply:responder_mismatch=10 ';
      expect(movedSet(before, after)).toContain('receipt-apply:identity_unresolved=1');
    });

    it('a responder_mismatch that moves DURING the window is still attributed', () => {
      // The honest residual: the diff narrows attribution to this leg's window, not its probe.
      // A retry landing inside the window must still surface (the script says so in-line).
      const before = 'receipt-apply:responder_mismatch=10 ';
      const after = 'receipt-apply:responder_mismatch=11 ';
      expect(movedSet(before, after)).toContain('receipt-apply:responder_mismatch=11');
    });

    it('an empty before-vector does not swallow a first-ever refusal', () => {
      expect(movedSet('', 'receipt-apply:identity_unresolved=1 ')).toContain(
        'receipt-apply:identity_unresolved=1',
      );
    });
  });
});
