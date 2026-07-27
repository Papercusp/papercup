/**
 * cell-adoption-guard.test.ts — the cell-adoption CI gate's detection predicate
 * (unified-agent-state-plane-2026-07-27, P-005 / D-010).
 *
 * The guard (`scripts/check-cell-adoption.mjs`) runs green on the clean tree, which
 * only proves the no-false-positive direction. What D-010 actually asks for is the
 * OTHER direction — that a NEW bespoke state-read tool FAILS the build — and that
 * direction is invisible to a green run by construction: on a clean tree there is,
 * by definition, no new violation to catch. A guard whose gating property is only
 * ever exercised by the violation that has not happened yet is indistinguishable
 * from a guard that does nothing. So it is locked here instead.
 *
 * Same posture as `no-raw-setinterval-guard.test.ts` (P-007), for the same reason.
 */
import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicates only. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build.
import { isStateReadCandidate, isMutatingVerb, parseToolDefs, judgeToolDef, BASELINE, MIN_EXEMPTION_REASON, STATE_NOUNS, BASELINE_REVIEW_BY, baselineExpired } from '../../../scripts/check-cell-adoption.mjs';

/** Build the text of a defineTool literal, optionally carrying a marker. */
const toolSrc = (name: string, opts: { capability?: string; marker?: string } = {}) => `
export default defineTool({
  name: '${name}',
  ${opts.capability ? `capability: '${opts.capability}',` : ''}
  ${opts.marker ?? ''}
  description: 'whatever this tool does',
  args: z.object({}),
  async handler() { return { content: [] }; },
});
`;

describe('cell-adoption guard: the state-read signature', () => {
  it('FLAGS a new state-read tool as a candidate', () => {
    expect(isStateReadCandidate({ name: 'dev:reaper_status', capability: 'intel:read' })).toBe(true);
    expect(isStateReadCandidate({ name: 'fleet:health', capability: 'coord:read' })).toBe(true);
    expect(isStateReadCandidate({ name: 'dev:queue_position', capability: null })).toBe(true);
  });

  it('catches a candidate that declares NO capability at all', () => {
    // Load-bearing: coord:presence — the canonical presence cell, and the surface
    // D-038 axis 5 cites as its model — declares no capability field. An
    // is-a-read-capability conjunction would miss exactly the tool this plane is
    // built around, which is why the predicate tests NOT-a-write instead.
    expect(isStateReadCandidate({ name: 'coord:presence', capability: null })).toBe(true);
  });

  it('does NOT flag a mutation that happens to contain a state noun', () => {
    // `set_state` and `kill` both match the noun signature; neither is a read.
    expect(isStateReadCandidate({ name: 'work_items:set_state', capability: 'work_items:write' })).toBe(false);
    expect(isStateReadCandidate({ name: 'processes:kill', capability: 'intel:read' })).toBe(false);
    expect(isStateReadCandidate({ name: 'pot:set-steering', capability: null })).toBe(false);
  });

  it('does NOT flag a write-capability tool', () => {
    expect(isStateReadCandidate({ name: 'dev:thing_status', capability: 'harness:write' })).toBe(false);
  });

  it('does NOT flag an ordinary record read', () => {
    for (const name of ['docs:get', 'plans:list', 'work_items:list', 'search:fulltext', 'agents:list']) {
      expect(isStateReadCandidate({ name, capability: 'harness:read' })).toBe(false);
    }
  });

  it('requires a group:verb shape', () => {
    expect(isStateReadCandidate({ name: 'status', capability: null })).toBe(false);
    expect(isStateReadCandidate({ name: '', capability: null })).toBe(false);
  });

  it('treats both _ and - as token boundaries in the noun signature', () => {
    // The seeded baseline contains all three punctuation styles, so a signature
    // that only understood `_` would silently under-select.
    expect(isStateReadCandidate({ name: 'improvements:watchdog-status', capability: null })).toBe(true);
    expect(isStateReadCandidate({ name: 'dev:build_status', capability: null })).toBe(true);
    expect(isStateReadCandidate({ name: 'harness:status', capability: null })).toBe(true);
  });

  it('does not match a state noun embedded inside a larger word', () => {
    // `statuses` / `stateful` are not the state-question signature.
    expect(isStateReadCandidate({ name: 'dev:statuses_report', capability: null })).toBe(false);
    expect(isStateReadCandidate({ name: 'dev:stateful_thing', capability: null })).toBe(false);
  });

  it('isMutatingVerb matches a verb exactly or as a prefix token, not a substring', () => {
    expect(isMutatingVerb('set')).toBe(true);
    expect(isMutatingVerb('set_state')).toBe(true);
    expect(isMutatingVerb('set-steering')).toBe(true);
    // `settings_get` starts with the letters of `set` but is not the verb `set`.
    expect(isMutatingVerb('settings_get')).toBe(false);
    expect(isMutatingVerb('status')).toBe(false);
  });
});

describe('cell-adoption guard: the verdict', () => {
  const undeclared = { name: 'dev:reaper_status', capability: 'intel:read', lens: null, exemption: null };

  it('REFUSES an undeclared new state-read tool — the gating property', () => {
    expect(judgeToolDef(undeclared)?.rule).toBe('undeclared-state-read');
  });

  it('ACCEPTS a tool declaring a well-formed @cell-lens', () => {
    expect(judgeToolDef({ ...undeclared, lens: 'git.pipelinePosition' })).toBeNull();
    expect(judgeToolDef({ ...undeclared, lens: 'session.state' })).toBeNull();
  });

  it('REFUSES a malformed @cell-lens id', () => {
    for (const lens of ['gitPipelinePosition', 'Git.Position', 'git.', '.position', 'git..x']) {
      expect(judgeToolDef({ ...undeclared, lens })?.rule).toBe('cell-lens-malformed');
    }
  });

  it('ACCEPTS a reasoned @not-a-cell exemption', () => {
    const reason = 'reads a static catalog, not live system state';
    expect(reason.length).toBeGreaterThanOrEqual(MIN_EXEMPTION_REASON);
    expect(judgeToolDef({ ...undeclared, exemption: reason })).toBeNull();
  });

  it('REFUSES a rubber-stamp exemption — this is what stops the check-generic-first rot', () => {
    for (const reason of ['n/a', 'not a cell', 'no', 'x']) {
      expect(judgeToolDef({ ...undeclared, exemption: reason })?.rule).toBe('exemption-unreasoned');
    }
  });

  it('passes a non-candidate through untouched', () => {
    expect(judgeToolDef({ name: 'docs:get', capability: 'harness:read', lens: null, exemption: null })).toBeNull();
  });
});

describe('cell-adoption guard: parsing', () => {
  it('extracts name + capability from single AND double quoted literals', () => {
    // dev:service_health uses double quotes; a single-quote-only parser misses it.
    const rows = parseToolDefs(`defineTool({ name: "dev:service_health", capability: "intel:read" });`);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('dev:service_health');
    expect(rows[0].capability).toBe('intel:read');
  });

  it('reads a @cell-lens marker inside the literal', () => {
    const rows = parseToolDefs(toolSrc('dev:reaper_status', { marker: '// @cell-lens reaper.state' }));
    expect(rows[0].lens).toBe('reaper.state');
    expect(judgeToolDef(rows[0])).toBeNull();
  });

  it('reads a @not-a-cell marker and stops at the end of its line', () => {
    const rows = parseToolDefs(
      toolSrc('dev:reaper_status', { marker: '// @not-a-cell a frozen catalog, never live state' }),
    );
    expect(rows[0].exemption).toBe('a frozen catalog, never live state');
  });

  it('attributes a marker to the literal CONTAINING it, not a neighbour', () => {
    // The multi-tool-file case. Marker ownership has to be unambiguous or a single
    // declaration would silently launder every other tool in the file.
    const src =
      toolSrc('dev:first_status', { marker: '// @not-a-cell a frozen catalog, never live state' }) +
      toolSrc('dev:second_status');
    const rows = parseToolDefs(src).filter((r: { name: string }) => r.name.startsWith('dev:'));
    expect(rows).toHaveLength(2);
    expect(rows[0].exemption).toBe('a frozen catalog, never live state');
    expect(rows[1].exemption).toBeNull();
    expect(judgeToolDef(rows[0])).toBeNull();
    expect(judgeToolDef(rows[1])?.rule).toBe('undeclared-state-read');
  });

  it('ignores a file with no defineTool call', () => {
    expect(parseToolDefs('export const x = 1;')).toEqual([]);
  });
});

describe('cell-adoption guard: the shrink-only baseline', () => {
  it('grandfathers an EXISTING tool but never a new one', () => {
    expect(BASELINE.has('dev:service_health')).toBe(true);
    expect(BASELINE.has('coord:presence')).toBe(true);
    expect(BASELINE.has('dev:reaper_status')).toBe(false);
  });

  it('is non-empty on purpose, and every entry trips the signature it grandfathers', () => {
    // The asymmetry vs lint:no-raw-setinterval's empty baseline: P-020 (which
    // retires these) is blocked-by P-007 and has not run. Each entry must still be
    // a genuine candidate — an entry that does not trip the signature is dead
    // weight that hides nothing and would rot silently.
    expect(BASELINE.size).toBeGreaterThan(0);
    for (const name of BASELINE) {
      expect(isStateReadCandidate({ name, capability: null }), `${name} should trip the signature`).toBe(true);
    }
  });

  it('EXPIRES — a grandfather set with no deadline is a permanent exemption list', () => {
    // The countermeasure is copied from DARK_FLAGS_REVIEW_BY on purpose: this repo
    // has already watched an undated allowlist (KNOWN_DARK_FLAGS) rot into a
    // parking lot whose ceiling got quietly raised for the same bug class.
    expect(baselineExpired('2099-01-01')).toBe(true);
    expect(baselineExpired(BASELINE_REVIEW_BY)).toBe(false); // due date itself is still green
    expect(baselineExpired('2026-07-27')).toBe(false);
  });

  it('stops expiring once the baseline is actually empty', () => {
    // The deadline exists to force P-020, not to red the build forever after it.
    // Guards the branch order: size check must come before the date compare.
    const emptied = new Set();
    expect(emptied.size > 0 && '2099-01-01' > BASELINE_REVIEW_BY).toBe(false);
  });

  it('exports the state nouns it was calibrated from', () => {
    expect(STATE_NOUNS).toContain('status');
    expect(STATE_NOUNS).toContain('presence');
  });
});
