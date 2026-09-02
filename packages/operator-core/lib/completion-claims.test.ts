/**
 * Tests for declared, machine-checkable completion claims (EI-22175397357614106).
 *
 * FALSIFIABILITY DISCIPLINE — no in-tree mutation.
 * The subject is a MODULE we import, so per CLAUDE.md § "Proving a guard is falsifiable"
 * the controls live permanently in this file rather than being produced by mutating the
 * shared checkout: every positive assertion is paired with a deliberately-wrong fixture
 * that MUST reach the opposite verdict. If the evaluator degenerated into "always
 * holds" — the failure mode that would make this whole mechanism worthless while looking
 * green — the CONTROL cases in each block fail, not the happy path.
 *
 * The calibration case the real subject must pass is `evaluates the live seeded-surface
 * claim`, which runs against the actual repo file rather than a fixture.
 */
import { describe, expect, it } from 'vitest';

import {
  type ClaimSourceReader,
  type CompletionClaim,
  evaluateCompletionClaim,
  evaluateCompletionClaims,
  renderCompletionClaimsReport,
  repoSourceReader,
} from './completion-claims';

/** An in-memory reader so no test touches (or mutates) the shared tree. */
function fixtureReader(files: Record<string, string>): ClaimSourceReader {
  return { readSource: (p) => (p in files ? files[p] : null) };
}

const SEED_FIXTURE = `
export const CORE_TOOLS: readonly string[] = [
  'coord:orient',
  'coord:send',
  'coord:dispatch',
];

export const QUEEN_TOOLS = ['coord:dispatch', 'legacy:verb'] as const;

const SPREAD_TOOLS: readonly string[] = ['coord:orient', ...EXTRA_TOOLS];

export function declaredFn(): void {}
const notExported = 1;
`;

const reader = fixtureReader({ 'seed.ts': SEED_FIXTURE });

describe('string-in-array claims', () => {
  it('HOLDS when the value is a literal element', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:dispatch', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('CONTROL — FALSIFIES the same claim shape against an array that lacks the value', () => {
    // This is the WI-37365 shape exactly: the verb sits in the retired tier only.
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:absent', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('falsified');
    expect(r.reason).toContain('coord:absent');
  });

  it('unwraps `as const` so the assertion suffix does not hide the array', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'QUEEN_TOOLS', value: 'coord:dispatch', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('expect:absent HOLDS on a fully-enumerated array that lacks the value', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'nope:verb', expect: 'absent' },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('CONTROL — expect:absent FALSIFIES when the value is in fact present', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:orient', expect: 'absent' },
      reader,
    );
    expect(r.verdict).toBe('falsified');
  });

  it('a SPREAD makes absence undecidable — unevaluatable, never a pass', () => {
    // The lesson the source item cites about itself: an incomplete enumeration reads
    // exactly like a passing guard. It must not.
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'SPREAD_TOOLS', value: 'coord:dispatch', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('unevaluatable');
    expect(r.reason).toMatch(/spread|computed/);
  });

  it('a SPREAD does not block a positive literal hit', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'SPREAD_TOOLS', value: 'coord:orient', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('a missing container is unevaluatable, NOT falsified (it may have been renamed)', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'seed.ts', container: 'NO_SUCH_ARRAY', value: 'x', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('unevaluatable');
  });

  it('an unreadable source is unevaluatable, NOT a pass', () => {
    const r = evaluateCompletionClaim(
      { kind: 'string-in-array', path: 'missing.ts', container: 'CORE_TOOLS', value: 'x', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('unevaluatable');
    expect(r.reason).toContain('not readable');
  });
});

describe('symbol-defined claims', () => {
  it('HOLDS for a declared, exported function when export is required', () => {
    const r = evaluateCompletionClaim(
      { kind: 'symbol-defined', path: 'seed.ts', symbol: 'declaredFn', expect: 'present', exported: true },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('CONTROL — FALSIFIES an export requirement the declaration does not meet', () => {
    const r = evaluateCompletionClaim(
      { kind: 'symbol-defined', path: 'seed.ts', symbol: 'notExported', expect: 'present', exported: true },
      reader,
    );
    expect(r.verdict).toBe('falsified');
    expect(r.reason).toContain('NOT exported');
  });

  it('HOLDS for a non-exported declaration when export is not required', () => {
    const r = evaluateCompletionClaim(
      { kind: 'symbol-defined', path: 'seed.ts', symbol: 'notExported', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('holds');
  });

  it('CONTROL — FALSIFIES a claim about a symbol that is simply not there', () => {
    const r = evaluateCompletionClaim(
      { kind: 'symbol-defined', path: 'seed.ts', symbol: 'ghostSymbol', expect: 'present' },
      reader,
    );
    expect(r.verdict).toBe('falsified');
  });
});

describe('path safety', () => {
  it('refuses absolute paths and traversal rather than resolving them', () => {
    const rr = repoSourceReader('/tmp/does-not-matter');
    expect(rr.readSource('/etc/passwd')).toBeNull();
    expect(rr.readSource('../../etc/passwd')).toBeNull();
  });
});

describe('report aggregation', () => {
  it('counts each verdict and flags any falsification', () => {
    const claims: CompletionClaim[] = [
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:orient', expect: 'present' },
      { kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:absent', expect: 'present' },
      { kind: 'string-in-array', path: 'gone.ts', container: 'X', value: 'y', expect: 'present' },
    ];
    const report = evaluateCompletionClaims(claims, reader);
    expect(report.held).toBe(1);
    expect(report.falsified).toBe(1);
    expect(report.unevaluatable).toBe(1);
    expect(report.anyFalsified).toBe(true);
    expect(renderCompletionClaimsReport(report)).toMatch(/FALSIFIED/);
  });

  it('CONTROL — a set with no falsification does not raise the flag', () => {
    const report = evaluateCompletionClaims(
      [{ kind: 'string-in-array', path: 'seed.ts', container: 'CORE_TOOLS', value: 'coord:send', expect: 'present' }],
      reader,
    );
    expect(report.anyFalsified).toBe(false);
    expect(report.falsified).toBe(0);
  });

  it('treats no declared claims as an empty report, not as a pass signal', () => {
    const report = evaluateCompletionClaims(undefined, reader);
    expect(report.results).toHaveLength(0);
    expect(report.anyFalsified).toBe(false);
    expect(renderCompletionClaimsReport(report)).toBe('no declared claims');
  });
});

describe('calibration against the live tree', () => {
  const repoRoot = new URL('../../../', import.meta.url).pathname;
  const invokePath = 'libs/papercusp/packages/orchestrator/src/invoke.ts';

  it('evaluates the live seeded-surface claim — the WI-37365 subject', () => {
    // A `falsified` here is a REAL regression: it means coord:dispatch was removed from
    // the live seeded surface again, re-creating the exact condition that made WI-37365's
    // close false and armed a downstream falsifier against a verb no session could call.
    // `unevaluatable` is acceptable (the array may legitimately be renamed) — but it can
    // never silently read as a pass, which is the property under test.
    const r = evaluateCompletionClaim(
      {
        kind: 'string-in-array',
        path: invokePath,
        container: 'CORE_MCP_TOOL_NAMES',
        value: 'coord:dispatch',
        expect: 'present',
      },
      repoSourceReader(repoRoot),
    );
    expect(r.verdict).not.toBe('falsified');
    expect(['holds', 'unevaluatable']).toContain(r.verdict);
  });

  it('POSITIVE CONTROL — the reader and parser actually reach that file', () => {
    // Without this, the test above would pass just as happily on an unreadable path,
    // which is the "checked zero files, therefore green" shape CLAUDE.md warns about.
    const r = evaluateCompletionClaim(
      {
        kind: 'string-in-array',
        path: invokePath,
        container: 'CORE_MCP_TOOL_NAMES',
        value: 'coord:orient',
        expect: 'present',
      },
      repoSourceReader(repoRoot),
    );
    expect(r.verdict).toBe('holds');
  });
});
