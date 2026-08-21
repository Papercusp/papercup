/**
 * The acceptance-rubric mandate must show the complete `rubrics:propose` envelope
 * (EI-20208171251920504).
 *
 * The live tool schema is the source of truth for required fields. This guard reads
 * the full doc corpus rather than the projected client file, because the acceptance
 * mandate is a harness_doc_parts invariant that is present in both projections.
 * The fixture is deliberately not a hand-copied second schema: if the tool adds a
 * required top-level field, this test fails until the agent-facing example names it.
 */
import { describe, expect, it } from 'vitest';
import { rubricsProposeArgs } from '../agent-tools/rubrics/propose';
import { readCorpus } from './corpus-subject';

const RUBRICS_PROPOSE_EXAMPLE = /`rubrics:propose\s*\{([^`]+)\}`/g;

function documentedFields(source: string): Set<string> {
  const candidates = [...source.matchAll(RUBRICS_PROPOSE_EXAMPLE)].map(
    (match) =>
      new Set([...match[1]!.matchAll(/\b([A-Za-z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1]!)),
  );
  const acceptance = candidates
    .filter((fields) => fields.has('kind') && fields.has('subjectPlan') && fields.has('classRef'))
    .sort((a, b) => b.size - a.size)[0];
  if (!acceptance) {
    throw new Error('acceptance-rubric rubrics:propose example is missing from the doc corpus');
  }
  return acceptance;
}

describe('acceptance-rubric documentation envelope', () => {
  it('names every required rubrics:propose field from the live schema', () => {
    const fields = documentedFields(readCorpus());
    const required = Object.entries(rubricsProposeArgs.shape)
      .filter(([, schema]) => !schema.isOptional())
      .map(([key]) => key);

    expect([...fields]).toEqual(expect.arrayContaining(required));
    expect([...fields]).toEqual(expect.arrayContaining(['kind', 'subjectPlan', 'classRef']));
  });

  it('keeps the documented acceptance envelope structurally admissible', () => {
    const parsed = rubricsProposeArgs.safeParse({
      rubricRef: 'acceptance-doc-claims-test',
      kind: 'acceptance',
      subjectPlan: 'plan-doc-claims-test',
      classRef: 'plan-class-bugfix',
      characteristic: 'documentation-contract',
      title: 'Documentation contract',
      criteria: [],
    });

    expect(parsed.success).toBe(true);
  });
});
