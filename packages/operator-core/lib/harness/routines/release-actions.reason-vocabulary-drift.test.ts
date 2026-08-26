/**
 * WI-42207 — the PRODUCER's verdict vocabulary and the CONSUMER's classification must not drift.
 *
 * `classifyGateStallStatus` ends in `return 'red'`. That default is load-bearing and dangerous in
 * equal measure: any reason code the producer emits but the classifier never names is silently
 * banked as a CODE RED — a red about code that was never judged.
 *
 * This has now happened three times, each time discovered only after it froze `main`:
 *   · 'error'                          (EI-21462211894072863, measured 2026-08-25 — reds hit 42)
 *   · 'dependency-prewarm-missing'     (P-007 — "WITHOUT it a typed prerequisite outage falls
 *                                       through to the default and fabricates a code red")
 *   · 'candidate-fossil'               (WI-42207, measured 2026-08-26 — reds hit 44, `main`
 *                                       frozen 6 days, `gate_health.failingTests` `[]` throughout
 *                                       because no run ever published a signature)
 *
 * Each fix added one `if`. None of them stopped the NEXT reason from drifting, because nothing
 * forces a new producer reason to be classified at all — the compiler is happy either way, and
 * the wrong answer is the silent one. That is what this test exists to change: adding a reason
 * code now FAILS here until somebody decides, in writing, which class it belongs to.
 *
 * Deliberately source-derived rather than hand-listed. A hand-maintained copy of the producer's
 * union is a second copy of a truth the code already owns, which is the very defect being
 * guarded — see CLAUDE.md's derived-truth ladder.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const PRODUCER = path.join(REPO_ROOT, 'apps/operator/lib/release/green-checkpoint.ts');
const CONSUMER = path.join(REPO_ROOT, 'packages/operator-core/lib/harness/routines/release-actions.ts');

/**
 * Reasons that fall through to `return 'red'` ON PURPOSE, because they DO establish something
 * about the code (or about a real, named gate condition) and so belong in the red streak.
 *
 * This list may SHRINK freely. Growing it is the reviewable act: every entry is a promise that a
 * run ending this way named a real, actionable cause rather than an empty `failingTests: []`.
 * If you cannot make that promise, the reason belongs in `classifyGateStallStatus` as
 * 'no-verdict' (not self-clearing, must stay counted) or 'noop' (self-clearing infra abort).
 */
const INTENTIONAL_CODE_RED = new Set([
  'not-green', // the suite ran and named failing tests — the one true code red
  'not-fast-forward', // the candidate genuinely cannot fast-forward `main`
  'create-failed', // the release ref could not be created; a real, named failure
  'perf-held', // perf regressed — a real verdict about the code, cause named in the reason
  'desktop-perf-held', // as above, desktop shell
  'delta-held', // delta budget exceeded — real and named
  'cupboard-hygiene-held', // hygiene gate — real and named
]);

/** The producer's `reason:` union, read out of its own type declaration. */
function producerReasons(): string[] {
  const src = readFileSync(PRODUCER, 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^\s*reason:\s*$/.test(l));
  expect(
    start,
    'could not locate the `reason:` union in green-checkpoint.ts — this guard parses it by shape, so a refactor of that declaration must update this parser (a silently-empty parse is exactly the failure mode being guarded)',
  ).toBeGreaterThan(-1);

  const found: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const member = line.match(/^\s*\|\s*"([a-z-]+)"/);
    if (member) {
      found.push(member[1]!);
      continue;
    }
    if (/;\s*$/.test(line) || /^\s*\w+[?]?:/.test(line)) break;
  }
  return [...new Set(found)];
}

/** Every reason literal `classifyGateStallStatus` explicitly names. */
function consumerNamedReasons(): string[] {
  const src = readFileSync(CONSUMER, 'utf8');
  const start = src.indexOf('function classifyGateStallStatus');
  expect(
    start,
    'could not locate classifyGateStallStatus in release-actions.ts — update this parser rather than deleting the guard',
  ).toBeGreaterThan(-1);
  // Bound the scan to the function body: from its declaration to the next top-level `}`.
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...new Set([...body.matchAll(/status === '([a-z-]+)'/g)].map((m) => m[1]!))];
}

describe('green-checkpoint reason vocabulary vs gate-stall classification (WI-42207)', () => {
  it('parses a non-trivial vocabulary from both sides — the guard must not pass vacuously', () => {
    // A source-parsing guard whose regex silently matches nothing reports a clean pass while
    // checking absolutely nothing. Assert both instruments actually found something first, so a
    // future refactor breaks the PARSER loudly instead of disarming the check quietly.
    const produced = producerReasons();
    const named = consumerNamedReasons();
    expect(produced.length, 'producer reason union parsed as empty').toBeGreaterThan(10);
    expect(named.length, 'consumer classification parsed as empty').toBeGreaterThan(5);
    expect(produced).toContain('not-green');
    expect(named).toContain('error');
  });

  it('classifies EVERY producer reason — a new one may not silently become a code red', () => {
    const named = new Set(consumerNamedReasons());
    const unclassified = producerReasons().filter(
      (reason) => !named.has(reason) && !INTENTIONAL_CODE_RED.has(reason),
    );

    expect(
      unclassified,
      `These green-checkpoint reason code(s) are emitted by the producer but never named by ` +
        `classifyGateStallStatus, so they fall through to \`return 'red'\` and bank a red about ` +
        `code that was never judged:\n\n  ${unclassified.join(', ')}\n\n` +
        `Decide, in writing, which class each belongs to:\n` +
        `  · 'noop'       — self-clearing infra abort; establishes nothing, must not be counted\n` +
        `  · 'no-verdict' — establishes nothing but is NOT self-clearing; counted as WEDGED via\n` +
        `                   consecutiveNoVerdict, leaving consecutiveReds (real code verdicts) alone\n` +
        `  · a real code red — then add it to INTENTIONAL_CODE_RED in this file, which is a\n` +
        `                   promise that such a run names an actionable cause rather than an\n` +
        `                   empty failingTests: []\n\n` +
        `This exact drift froze main for 6 days on 2026-08-26 ('candidate-fossil'), and twice ` +
        `before that ('error', 'dependency-prewarm-missing').`,
    ).toEqual([]);
  });

  it("keeps 'candidate-fossil' classified — the regression this guard was built from", () => {
    // A withheld verdict publishes NO failing-test signature, so it can never be a code red.
    // Pinned explicitly so a future edit to the classifier cannot quietly drop it back.
    expect(consumerNamedReasons()).toContain('candidate-fossil');
    expect(INTENTIONAL_CODE_RED.has('candidate-fossil')).toBe(false);
  });

  it('does not let INTENTIONAL_CODE_RED accumulate reasons the consumer already handles', () => {
    // Keeps the allowlist honest: once a reason is properly classified, its waiver must go, so
    // the list only ever describes genuine fallthroughs.
    const named = new Set(consumerNamedReasons());
    const redundant = [...INTENTIONAL_CODE_RED].filter((reason) => named.has(reason));
    expect(
      redundant,
      `INTENTIONAL_CODE_RED still waives reason(s) that classifyGateStallStatus now names ` +
        `explicitly: ${redundant.join(', ')}. Remove them — the allowlist is shrink-only and ` +
        `should describe only true fallthroughs.`,
    ).toEqual([]);
  });
});
