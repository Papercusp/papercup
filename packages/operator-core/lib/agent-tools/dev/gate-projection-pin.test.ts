/**
 * gate-projection-pin.test.ts — WI-2140908.
 *
 * `dev:pipeline_position` projects the resolver's gate struct through a hand-maintained
 * list of FIELD NAMES. That list is code-describing metadata (CLAUDE.md: "derive, pin, or
 * attest — never hand-maintain") and it has drifted twice:
 *
 *   EI-20687018966071866 — `gate.greenCheckpoint.candidate`'s declared path went missing.
 *   WI-2140908           — `candidateFailures` went missing.
 *
 * Both failed the same misleading way. The projection drops the field, `readCell` then
 * finds the cell's declared path absent, and `state:read` reports "the cell's declared
 * path and its resolver's shape have drifted apart" — pointing at the RESOLVER, which is
 * correct, instead of at the projection, which is not. An agent following that message
 * audits the wrong file; the one that hit WI-2140908 fell back to hand-written
 * `test_runs` SQL, which is precisely the defect the cell was built to end.
 *
 * This is the PIN rung of the ladder: the field list stays hand-written (the budget makes
 * "project everything" wrong), but a field that is neither projected nor explicitly
 * classified as omitted now FAILS THE BUILD instead of vanishing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  PIPELINE_GATE_FIELDS_NOT_PROJECTED,
  PIPELINE_GATE_PROJECTED_FIELDS,
  PIPELINE_GATE_SEPARATELY_PROJECTED,
} from './pipeline_position';

/**
 * The subject path is overridable so falsifiability can be proven against a COPY outside
 * the tree (`scripts/mutation-probe.sh`, tier 2). The shared checkout is swept into commits
 * every few minutes, so mutating the real file in place to test this guard risks committing
 * the mutant even when nothing goes wrong — this one line is what makes the safe tier available.
 */
const RESOLVER_SOURCE_PATH =
  process.env.PIPELINE_GATE_PIN_SOURCE ?? fileURLToPath(new URL('../../git-pipeline-position.ts', import.meta.url));

/**
 * Extract the depth-1 field names of the `gate: { … }` block of the resolver's returned
 * struct, by brace-walking the source. We parse rather than import because the field set
 * is a TYPE — it does not exist at runtime, so there is nothing to reflect over.
 */
function gateStructFields(source: string): string[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^ {2}gate: \{\s*$/.test(line));
  if (start === -1) return [];

  const fields: string[] = [];
  let depth = 1;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    // Ignore comment bodies: a `{` inside prose would corrupt the depth count.
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

    if (depth === 1) {
      const match = /^ {4}([A-Za-z_][A-Za-z0-9_]*)\??:/.exec(code);
      if (match?.[1]) fields.push(match[1]);
    }

    depth += (code.match(/\{/g) ?? []).length;
    depth -= (code.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
  }

  return [...new Set(fields)];
}

describe('dev:pipeline_position gate projection is pinned to the resolver struct', () => {
  const source = readFileSync(RESOLVER_SOURCE_PATH, 'utf8');
  const structFields = gateStructFields(source);

  /**
   * CALIBRATION — the instrument must be able to fail. Every assertion below compares
   * against `structFields`, so a parser that silently returned `[]` would make the real
   * test pass while measuring nothing: the zero-work false green this repo keeps paying
   * for (a `-t` filter matching no tests, a head-truncated grep, a wrong-relation SQL
   * zero-row). These two checks are what make the pin's green mean something.
   */
  it('CALIBRATION: the extractor actually finds the gate struct', () => {
    expect(structFields.length).toBeGreaterThanOrEqual(15);
    // Anchors at both ends of the block, so a parser that stopped early is caught too.
    expect(structFields).toContain('stalled');
    expect(structFields).toContain('candidateFailures');
    expect(structFields).toContain('qualification');
  });

  it('every gate field is either projected or explicitly classified as omitted', () => {
    const classified = new Set<string>([
      ...PIPELINE_GATE_PROJECTED_FIELDS,
      ...PIPELINE_GATE_SEPARATELY_PROJECTED,
      ...PIPELINE_GATE_FIELDS_NOT_PROJECTED,
    ]);

    const unclassified = structFields.filter((field) => !classified.has(field));

    expect(
      unclassified,
      `Gate field(s) ${unclassified.join(', ')} exist on the resolver struct but are neither ` +
        'projected by dev:pipeline_position nor listed in PIPELINE_GATE_FIELDS_NOT_PROJECTED. ' +
        'A caller reading one through a state cell will be told the resolver "drifted apart" ' +
        '(WI-2140908). Add it to PIPELINE_GATE_PROJECTED_FIELDS, or to ' +
        'PIPELINE_GATE_FIELDS_NOT_PROJECTED with the reason.',
    ).toEqual([]);
  });

  it('nothing is classified that the resolver struct no longer has', () => {
    const known = new Set(structFields);
    const stale = [
      ...PIPELINE_GATE_PROJECTED_FIELDS,
      ...PIPELINE_GATE_SEPARATELY_PROJECTED,
      ...PIPELINE_GATE_FIELDS_NOT_PROJECTED,
    ].filter((field) => !known.has(field));

    expect(
      stale,
      `Field(s) ${stale.join(', ')} are classified in pipeline_position.ts but no longer exist ` +
        'on the resolver gate struct — the projection is carrying a dead name.',
    ).toEqual([]);
  });

  it('the field WI-2140908 was filed for is projected, not omitted', () => {
    // A regression guard with a stated subject: this is the field whose absence broke
    // `state:read { cell: "gate.greenCheckpoint.candidateFailures" }`.
    expect(PIPELINE_GATE_PROJECTED_FIELDS).toContain('candidateFailures');
    expect(PIPELINE_GATE_FIELDS_NOT_PROJECTED).not.toContain('candidateFailures');
  });
});
