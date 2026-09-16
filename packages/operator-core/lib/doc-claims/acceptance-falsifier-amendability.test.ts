/**
 * R-3 / P-003 of plan `acceptance-machinery-seam-fixes-2026-09-16`.
 *
 * Two claims this repo's acceptance machinery rests on, neither of which any
 * test previously held down. Both were found by the 2026-09-16 audit
 * (WI-10001661), and both are the kind that rot SILENTLY — the code keeps
 * working, the prose keeps reading true, and the gap only shows up when an
 * agent acts on a belief the code stopped honouring.
 *
 * CLAIM A — the falsifier is amendable.
 *   A defective acceptance BAR is repaired by amending its `driftMarkers`
 *   (the falsifier's stored spelling). A whole wake was once lost to the
 *   opposite belief — "rubrics:amend structurally CANNOT modify the
 *   falsifier" — which sent the author down the far more expensive
 *   rubrics:propose path. The claim is true only while `driftMarkers` stays
 *   in `AMENDABLE_CRITERION_FIELDS`; drop it and every recorded "amend the
 *   falsifier" instruction silently becomes a lie.
 *
 * CLAIM B — the bar contract snapshot grades UNSCOPED.
 *   The ship gate's verdict must be computed over the whole active evidence
 *   set. If the snapshot ever starts handing the adequacy evaluator a
 *   narrowed selection, a PINNED cohort could produce a passing ship verdict
 *   — which is exactly the confusion P-001 exists to prevent one layer up.
 *   A selector added here would not fail any existing test: the call would
 *   still typecheck, still return a verdict, and still look correct.
 *
 * FALSIFIABILITY (CLAUDE.md's mutation-probe rule, tier 2): every subject
 * path is overridable, so this guard can be proved falsifiable against a COPY
 * outside the tree. That matters here because the shared checkout is swept
 * into commits every few minutes, so the obvious proof — mutate the real
 * source, run, restore — can have the mutant committed by a sweep even when
 * nothing goes wrong. Each claim is paired with a vacuity floor, so a source
 * file rewritten into a stub fails here instead of passing quietly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';

const RUBRICS_RELPATH = 'packages/operator-core/lib/rubrics.ts';
const AMEND_RELPATH = 'packages/operator-core/lib/agent-tools/rubrics/amend.ts';
const SNAPSHOT_RELPATH = 'packages/operator-core/lib/acceptance-bar-contract-snapshot.ts';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

const source = (override: string | undefined, relpath: string): string =>
  override ? readFileSync(override, 'utf8') : read(relpath);

const rubrics = (): string => source(process.env.PAPERCUSP_RUBRICS_SRC, RUBRICS_RELPATH);
const amend = (): string => source(process.env.PAPERCUSP_AMEND_SRC, AMEND_RELPATH);
const snapshot = (): string => source(process.env.PAPERCUSP_BAR_SNAPSHOT_SRC, SNAPSHOT_RELPATH);

/** The declared amendable-field list, parsed from its single source of truth. */
function amendableCriterionFields(text: string): string[] {
  const match = /export const AMENDABLE_CRITERION_FIELDS\s*=\s*\[([^\]]*)\]/.exec(text);
  if (!match) return [];
  return [...match[1]!.matchAll(/'([^']+)'/g)].map((entry) => entry[1]!);
}

/**
 * The full argument text of the snapshot's `evaluateSpecTestAdequacy(...)`
 * call, by brace matching rather than a fixed window — a window would silently
 * stop covering the call the moment an argument is added, which is precisely
 * the change this guard exists to catch.
 */
function adequacyCallArgs(text: string): string[] {
  const calls: string[] = [];
  const needle = 'evaluateSpecTestAdequacy(';
  let from = 0;
  for (;;) {
    const start = text.indexOf(needle, from);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = start + needle.length - 1; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    calls.push(text.slice(start + needle.length, end));
    from = end;
  }
  return calls;
}

/**
 * Tokens that would narrow the graded population. `evidenceRefs` / `workItemIds`
 * are the selector spellings the adequacy evaluator and its rerun recipe accept;
 * `rerunSelection` carries a pinned cohort through the same seam.
 */
const SELECTOR_TOKENS = ['evidenceRefs', 'workItemIds', 'rerunSelection'];

describe('CLAIM A — the acceptance falsifier is reachable through the amendment path', () => {
  it('vacuity floor: the amendable-field list parses and is non-empty', () => {
    // Without this, a rubrics.ts rewritten into a stub would make the
    // assertion below unreachable rather than failing.
    const fields = amendableCriterionFields(rubrics());
    expect(fields.length).toBeGreaterThan(0);
    expect(fields).toContain('title');
  });

  it('driftMarkers is amendable, so a defective falsifier can be repaired by amending', () => {
    expect(amendableCriterionFields(rubrics())).toContain('driftMarkers');
  });

  it('the amend tool still documents driftMarkers as the falsifier', () => {
    // The correspondence is what makes "amend the falsifier" findable by an
    // agent reading the tool rather than the rubric source. If this prose is
    // dropped, the capability survives but becomes undiscoverable — which is
    // how the false "cannot amend the falsifier" belief formed in the first place.
    const text = amend();
    expect(text).toContain('driftMarkers');
    expect(text).toContain('acceptance.falsifier');
  });
});

describe('CLAIM B — the bar contract snapshot grades adequacy UNSCOPED', () => {
  it('vacuity floor: the snapshot really calls the adequacy evaluator', () => {
    const calls = adequacyCallArgs(snapshot());
    expect(calls.length).toBeGreaterThan(0);
    // Proves the brace matcher captured real arguments, not an empty slice.
    for (const args of calls) {
      expect(args).toContain('clause');
      expect(args).toContain('classRef');
    }
  });

  it('passes no evidence selector, so the ship verdict is computed over the active set', () => {
    for (const args of adequacyCallArgs(snapshot())) {
      for (const token of SELECTOR_TOKENS) {
        expect(args).not.toContain(token);
      }
    }
  });

  it('the matcher would SEE a selector if one were added (control)', () => {
    // A negative assertion is only worth what its detector is worth: if
    // adequacyCallArgs silently returned empty slices, the test above would
    // pass against a call that DOES narrow the population. This control runs
    // the same matcher over a fixture that carries a selector.
    const fixture = 'const r = evaluateSpecTestAdequacy({ clause, evidence, classRef, evidenceRefs: pinned });';
    const args = adequacyCallArgs(fixture);
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('evidenceRefs');
  });
});

/**
 * R-7 / P-010 of the same plan — the reviewer-handoff half.
 *
 * The approval ceremony only works if the reviewer can actually READ the
 * approval object. Routing it through the work-item PAYLOAD requires
 * `payloadTier:'full'`, which a trimmed or judge-scoped reader never gets — so
 * the reviewer is pointed at an object they cannot copy, and the ceremony
 * stalls on a surface difference nobody named. A THREAD POST renders on every
 * surface, so that is what the chaining guidance must route.
 *
 * This rots silently in the usual way: the payload route still typechecks,
 * still stores the object, and still reads correct to whoever has the full
 * tier. Same tier-2 falsifiability as its siblings above — the subject is
 * `PAPERCUSP_AMEND_SRC`-overridable, so this is provable against a copy.
 */
describe('rubrics:amend routes the approval object to a surface the reviewer can read (R-7)', () => {
  /** The `chaining` guidance string, parsed from its single source of truth. */
  function chainingGuidance(text: string): string {
    const match = /\bchaining:\s*\n?\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(text);
    return match ? match[1]! : '';
  }

  // The claim is about the ROUTE, not the word: the guidance should still NAME
  // payloadTier when explaining why the payload route fails. What must be gone is
  // the reviewer being SENT to a payload-tier read.
  const PAYLOAD_TIER_ROUTE_RE = /work_items:get\s*\{[^}]*payloadTier/;

  it('routes the approval through a thread comment, not a payload-tier read', () => {
    const chaining = chainingGuidance(amend());
    // The control: the matcher found a real, non-trivial guidance string. Without
    // this, a parse miss would satisfy every negative assertion below.
    expect(chaining.length).toBeGreaterThan(80);
    expect(chaining).toMatch(/work_items:comment/);
    expect(chaining).toMatch(/thread-post:/);
    expect(chaining).not.toMatch(PAYLOAD_TIER_ROUTE_RE);
  });

  it('says WHY the payload route fails, so the fix is not re-litigated', () => {
    // A bare removal would satisfy the assertion above and teach nothing; the
    // next author would re-add the payload route for the same reason it existed.
    const chaining = chainingGuidance(amend());
    expect(chaining).toMatch(/every surface/i);
    expect(chaining).toMatch(/payloadTier/);
  });

  it('the matcher would SEE a payload-tier route if one were there (control)', () => {
    const fixture = `chaining:\n      "amend { dryRun:true } → reviewer reads work_items:get { id:'<id>', payloadTier:'full' } → work_items:comment → amend { approvalRef:'thread-post:<id>' }",`;
    const chaining = chainingGuidance(fixture);
    expect(chaining).toMatch(PAYLOAD_TIER_ROUTE_RE);
  });
});
