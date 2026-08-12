/**
 * registry-drift.test.ts — the DB-projection drift check
 * (plan `bash-to-tool-substitution-2026-07-26`, P-018).
 *
 * These tests exist because the check they cover found a defect the moment it
 * ran: FOUR stale rows, not the three that were known. The unknown fourth was
 * `host-job-liveness-query`, whose stored `bash_pattern` had diverged from the
 * pair's — so both PreToolUse hooks were matching commands with a DIFFERENT
 * REGEX than the one the `not-a-substitute` verdict was earned under. That is
 * WI-5998's hazard (enforcement divorced from its evidence) in the pattern
 * dimension rather than the flags dimension, and no test or gate could see it.
 *
 * So the cases below are not decoration: each one is a drift SHAPE that was
 * live in the table, or that the seeder's own `ON CONFLICT` semantics make
 * possible. Run:
 *   npm run test:file -- packages/operator-core/lib/bash-substitution/registry-drift.test.ts
 */
import { describe, expect, it } from 'vitest';
import { loadPairFixtures } from './corpus';
import type { SubstitutionRow } from './match';
import { BASH_GATE_PAIRS } from './pairs';
import { diffRegistry, expectedRows, formatDrift, type ExpectedRow } from './registry-drift';

/** A seeded row that agrees with `want` on every compared field. */
function rowFor(want: ExpectedRow, overrides: Partial<SubstitutionRow> = {}): SubstitutionRow {
  return {
    intentLabel: want.intentLabel,
    bashPattern: want.bashPattern,
    bashPatternFlags: want.bashPatternFlags,
    toolName: want.toolName,
    tier: 'observe',
    advisoryText: want.advisoryText,
    equivalenceVerdict: want.equivalenceVerdict,
    ...overrides,
  };
}

describe('expectedRows', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('derives one row per audited pair', () => {
    expect(expected).toHaveLength(BASH_GATE_PAIRS.length);
    expect(new Set(expected.map((e) => e.intentLabel)).size).toBe(BASH_GATE_PAIRS.length);
  });

  /**
   * The verdict must come from the SAMPLE, not from the pair's recorded
   * `expectedVerdict` — otherwise this check compares one hand-written claim
   * against another and can never detect that the evidence moved.
   */
  it('recomputes the verdict from the frozen sample rather than copying expectedVerdict', () => {
    for (const pair of BASH_GATE_PAIRS) {
      const row = expected.find((e) => e.intentLabel === pair.intentLabel);
      expect(row, `${pair.id} produced no expected row`).toBeDefined();
      expect(row!.equivalenceVerdict).toBe(pair.expectedVerdict);
    }
  });

  it('carries the pattern SOURCE and FLAGS separately, as the registry stores them', () => {
    for (const pair of BASH_GATE_PAIRS) {
      const row = expected.find((e) => e.intentLabel === pair.intentLabel)!;
      expect(row.bashPattern).toBe(pair.bashPattern.source);
      expect(row.advisoryText).toBe(pair.advisoryText);
    }
  });
});

describe('diffRegistry', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('reports NO drift when the table matches the pairs', () => {
    expect(diffRegistry(expected, expected.map((e) => rowFor(e)))).toEqual([]);
  });

  it('ignores tier, so a row promoted by an observation window is not called drifted', () => {
    // P-020 promotion is state the seeder deliberately does NOT overwrite.
    // Flagging it would report the system working correctly and train the
    // reader to ignore the report.
    const rows = expected.map((e, i) => rowFor(e, i === 0 ? { tier: 'advise' } : {}));
    expect(diffRegistry(expected, rows)).toEqual([]);
  });

  it('detects a stale ADVISORY — the shape that told agents to keep using ss/lsof after the tool existed', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'listening-socket-query' ? { advisoryText: 'there is no tool form today' } : {}),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'changed', intentLabel: 'listening-socket-query' });
    expect(drifts[0].kind === 'changed' && drifts[0].fields.map((f) => f.field)).toEqual(['advisoryText']);
  });

  it('detects a re-pointed TOOL and VERDICT together (D-018: service_health → listening_ports)', () => {
    const rows = expected.map((e) =>
      rowFor(
        e,
        e.intentLabel === 'listening-socket-query'
          ? { toolName: 'dev:service_health', equivalenceVerdict: 'not-a-substitute' }
          : {},
      ),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields.map((f) => f.field).sort()).toEqual([
      'equivalenceVerdict',
      'toolName',
    ]);
  });

  /**
   * The regression guard for the defect this check found on its first run.
   * A drifted pattern means the gate enforces a regex no sample was scored
   * against — silent, and invisible to every other gate in the plan.
   */
  it('detects a drifted bash PATTERN, the defect the first live run surfaced', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'host-job-liveness-query' ? { bashPattern: String.raw`^(?:ps|pgrep)\b` } : {}),
    );
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0].field).toBe('bashPattern');
  });

  it('detects a drifted pattern FLAGS (WI-5998: same source, different regex)', () => {
    const rows = expected.map((e, i) => rowFor(e, i === 0 ? { bashPatternFlags: 'i' } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0].field).toBe('bashPatternFlags');
  });

  it('detects a MISSING row — a pair the gate cannot enforce because it was never seeded', () => {
    const rows = expected.slice(1).map((e) => rowFor(e));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'missing', intentLabel: expected[0].intentLabel });
  });

  /**
   * The drift direction `gen-tool-routing --check` is structurally blind to,
   * named in its own docstring: it reads the pairs and never the DB, so a row
   * with a novel intent_label is enforced by both hooks yet appears in no
   * prose and rests on no sample. Only a DB-reading check can see it.
   */
  it('detects an ORPHAN row that no pair produces — enforced, but resting on no sample', () => {
    const rows = [
      ...expected.map((e) => rowFor(e)),
      {
        intentLabel: 'hand-inserted-rule',
        bashPattern: '^rm\\b',
        bashPatternFlags: '',
        toolName: 'some:tool',
        tier: 'deny' as const,
        advisoryText: 'inserted by hand, audited by nobody',
        equivalenceVerdict: 'unaudited' as const,
      },
    ];
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ kind: 'orphan', intentLabel: 'hand-inserted-rule', tier: 'deny' });
  });

  it('treats a NULL advisory as drift rather than throwing', () => {
    const rows = expected.map((e, i) => rowFor(e, i === 0 ? { advisoryText: null } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts).toHaveLength(1);
    expect(drifts[0].kind === 'changed' && drifts[0].fields[0]).toMatchObject({ field: 'advisoryText', actual: '' });
  });

  it('reports every drifted row, not just the first', () => {
    const rows = expected.slice(2).map((e, i) => rowFor(e, i === 0 ? { toolName: 'wrong:tool' } : {}));
    const drifts = diffRegistry(expected, rows);
    expect(drifts.filter((d) => d.kind === 'missing')).toHaveLength(2);
    expect(drifts.filter((d) => d.kind === 'changed')).toHaveLength(1);
  });
});

describe('formatDrift', () => {
  const expected = expectedRows(loadPairFixtures(BASH_GATE_PAIRS));

  it('says so plainly when the registry is clean', () => {
    expect(formatDrift([])).toMatch(/^✓ bash_tool_substitutions matches the audited pairs/);
  });

  it('names the row, the field, and BOTH sides so the report is actionable without a second query', () => {
    const rows = expected.map((e) =>
      rowFor(e, e.intentLabel === 'listening-socket-query' ? { toolName: 'dev:service_health' } : {}),
    );
    const out = formatDrift(diffRegistry(expected, rows));
    expect(out).toContain('listening-socket-query');
    expect(out).toContain('toolName');
    expect(out).toContain('dev:service_health'); // what the DB holds
    expect(out).toContain('dev:listening_ports'); // what the pairs say
  });

  it('distinguishes the three drift kinds by label', () => {
    const out = formatDrift([
      { kind: 'missing', intentLabel: 'a', expected: expected[0] },
      { kind: 'orphan', intentLabel: 'b', toolName: 't', tier: 'deny' },
      { kind: 'changed', intentLabel: 'c', fields: [{ field: 'toolName', expected: 'x', actual: 'y' }] },
    ]);
    expect(out).toContain('MISSING');
    expect(out).toContain('ORPHAN');
    expect(out).toContain('STALE');
  });

  it('clips a long advisory so a report stays readable in a terminal', () => {
    const long = 'x'.repeat(400);
    const out = formatDrift([
      { kind: 'changed', intentLabel: 'c', fields: [{ field: 'advisoryText', expected: long, actual: long }] },
    ]);
    expect(out).toContain('…');
    expect(out).not.toContain(long);
  });
});
