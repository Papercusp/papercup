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

/**
 * Read the top-level object keys from the doc example. The mandate deliberately
 * uses shorthand for caller-supplied values (`rubricRef`, `characteristic`,
 * `title`), so a `key:`-only regex drops three required fields even though the
 * example names them. Split only on top-level commas so commas inside criteria
 * arrays/objects or quoted text cannot manufacture fields.
 */
function exampleFields(fragment: string): Set<string> {
  const entries: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let depth = 0;

  for (let i = 0; i < fragment.length; i += 1) {
    const char = fragment[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '[' || char === '{' || char === '(') depth += 1;
    else if (char === ']' || char === '}' || char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      entries.push(fragment.slice(start, i));
      start = i + 1;
    }
  }
  entries.push(fragment.slice(start));

  return new Set(
    entries
      .map((entry) => entry.trim().match(/^([A-Za-z][A-Za-z0-9]*)\s*(?::|$)/)?.[1])
      .filter((field): field is string => Boolean(field)),
  );
}

function documentedFields(source: string): Set<string> {
  const candidates = [...source.matchAll(RUBRICS_PROPOSE_EXAMPLE)].map((match) =>
    exampleFields(match[1]!),
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
  it('recognizes both explicit and caller-supplied shorthand fields without reading nested criteria', () => {
    expect(
      [...exampleFields("rubricRef, kind:'acceptance', criteria:[{ id:'outcome', checks:[1, 2] }], title")],
    ).toEqual(['rubricRef', 'kind', 'criteria', 'title']);
  });

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
