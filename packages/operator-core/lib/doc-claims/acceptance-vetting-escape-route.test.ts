/**
 * R-5 / P-005 of plan `bar-reporting-layer-repairs-2026-09-07` — the
 * DOCUMENTATION half of the clause.
 *
 * `grader_is_sole_vetting_critic` (vet first, then you are the sole recorded
 * critic) and `bar_snapshot_vetting_stale` (grade first, so no attestation
 * exists) read as a closed two-party loop. They are not one: the guard unions
 * critics across BOTH vetting channels at the current revision and refuses only
 * when every recorded critic collapses to the grader's own party, so the axis
 * that actually moves is INDEPENDENCE, not ordering. Before this plan that
 * escape existed only inside `resolveAggregatedVettingCritics` — discoverable
 * by reading the source, after the expensive work was already done.
 *
 * The clause's falsifier fails the repair if the route is "absent from
 * documentation OR absent from the refusal payload", so it takes two guards.
 * The refusal payload is asserted behaviourally next door, in
 * `agent-tools/scorecards/grader-eligibility.test.ts` (it executes the function
 * under the mock harness that already lives there). This file owns the
 * documentation half, and the pin BETWEEN them: the `docRef` the code emits
 * must resolve to the doc that carries the route, so the two cannot drift into
 * pointing at each other's absence.
 *
 * Same fixture-control discipline as the sibling guards in this directory
 * (CLAUDE.md's mutation-probe rule, the "module you import" tier): the
 * assertions below are paired with a vacuity floor, so a doc rewritten into a
 * stub fails here instead of passing quietly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './corpus-subject';

/** The `docRef` value `grader-eligibility.ts` puts on the refusal payload. */
const DOC_REF = 'agent-insights/acceptance-rubric-vetting';
const DOC_RELPATH = `apps/operator-docs/src/content/docs/${DOC_REF}.mdx`;
const GUARD_RELPATH = 'packages/operator-core/lib/agent-tools/scorecards/grader-eligibility.ts';

const read = (relpath: string): string => readFileSync(join(ROOT, relpath), 'utf8');

/**
 * The subject path is overridable so this guard's falsifiability can be proved
 * against a COPY outside the tree — the tier-2 route in CLAUDE.md's
 * mutation-probe rule. It matters here because the shared checkout is swept
 * into commits every few minutes, so the obvious proof (mutate the real doc,
 * run, restore) can have the mutant committed by a sweep even when nothing
 * fails. Defaults to the real doc, so an ordinary run is unaffected.
 */
const doc = (): string =>
  process.env.PAPERCUSP_VETTING_DOC
    ? readFileSync(process.env.PAPERCUSP_VETTING_DOC, 'utf8')
    : read(DOC_RELPATH);

describe('the vetting/grading escape route is documented, not only in the source', () => {
  it('the docRef the refusal emits resolves to a real doc', () => {
    // The pin. A renamed or moved runbook must fail HERE, loudly, rather than
    // leaving the refusal pointing an already-blocked agent at nothing.
    expect(() => doc()).not.toThrow();
    expect(read(GUARD_RELPATH)).toContain(`docRef: '${DOC_REF}'`);
  });

  it('names both refusals an agent actually meets', () => {
    const text = doc();

    // Without both names the reader cannot match the page to the error in front
    // of them, which is the only moment they will come looking.
    expect(text).toContain('grader_is_sole_vetting_critic');
    expect(text).toMatch(/bar_snapshot_vetting_(missing|stale)/);
  });

  it('states that the pair is NOT a deadlock and that independence is the axis', () => {
    const text = doc();

    expect(text).toMatch(/not a deadlock/i);
    // The load-bearing correction: ordering is what agents try, and it never works.
    expect(text).toMatch(/second INDEPENDENT critic/i);
  });

  it('gives the concrete route: a second critic, the other channel, the current revision', () => {
    const text = doc();

    expect(text).toMatch(/vettingConsult/);
    expect(text).toMatch(/vettingWorkItem/);
    expect(text).toMatch(/current revision/i);
    expect(text).toContain('meta-acceptance-rubric');
    // How to actually find someone outside your lineage.
    expect(text).toMatch(/coord:presence/);
  });

  it('names what LOOKS like the escape and is not', () => {
    const text = doc();

    // A doc that lists only the happy path sends agents down each of these in
    // turn, at a full ceremony cycle apiece.
    expect(text).toMatch(/collapseCriticsToSoleParty|same lineage|own spawn\/rebind lineage/i);
    expect(text).toMatch(/newer revision/i);
  });

  it('CONTROL: the route is asserted in prose, not satisfied by the frontmatter alone', () => {
    // Vacuity floor. Every assertion above is a substring match, so a doc whose
    // body was replaced by a stub could still pass them if the terms happened to
    // survive in frontmatter or a link. Pin the section that carries the route.
    const text = doc();
    const heading = text.indexOf('## The vetting/grading separation is NOT a deadlock');
    expect(heading).toBeGreaterThan(-1);

    const section = text.slice(heading, text.indexOf('\n## ', heading + 1));
    expect(section.length).toBeGreaterThan(800);
    expect(section).toContain('grader_is_sole_vetting_critic');
    expect(section).toContain('vettingWorkItem');
    expect(section).toMatch(/second INDEPENDENT critic/i);
  });
});
