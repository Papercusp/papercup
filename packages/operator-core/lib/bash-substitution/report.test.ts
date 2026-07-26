/**
 * Tests for the substitution report (plan `bash-to-tool-substitution-2026-07-26`,
 * P-002).
 *
 * The failure modes that matter here are all ways the report could look right
 * and be wrong: counting the synthetic result-bytes row as a tool call, folding
 * a bucket row into the call denominator, reporting a 1-day window as if it
 * were the 7-day baseline's peer, or showing 0% substitution for an intent that
 * simply never came up. There is a test for each.
 */

import { describe, expect, it } from 'vitest';
import {
  ROLLUP_CORPUS_WORKSPACE,
  clampReportSinceDays,
  frozenBaselineOf,
  gradeSubstitution,
  readSubstitutionReport,
  summarizeSubstitutionReport,
  type CounterpartRow,
  type UsageWindowRow,
} from './report';
import { RESULT_BYTES_TOOL } from './usage-rollup';
import type { SubstitutionRow } from './match';

const DAY = '2026-07-26';

function usageRow(over: Partial<UsageWindowRow> = {}): UsageWindowRow {
  return {
    toolName: 'Bash', verb: '', intentLabel: '',
    calls: 0, atoms: 0, resultBytes: 0, sessions: 1,
    firstDay: DAY, lastDay: DAY,
    ...over,
  };
}

function regRow(over: Partial<SubstitutionRow> = {}): SubstitutionRow {
  return {
    intentLabel: 'file-range-read',
    bashPattern: String.raw`^sed\s+-n`,
    bashPatternFlags: '',
    toolName: 'capability:read',
    tier: 'observe',
    advisoryText: null,
    equivalenceVerdict: 'equivalent',
    ...over,
  };
}

const noBaseline = () => null;

describe('summarizeSubstitutionReport — the headline share', () => {
  it('computes Bash share over per-CALL rows only', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', calls: 40, sessions: 12 }),
        usageRow({ toolName: 'Read', calls: 60 }),
      ],
      counterparts: [],
      registry: [],
      baselineOf: noBaseline,
    });
    expect(r.calls).toMatchObject({ bash: 40, total: 100, bashSessions: 12 });
    expect(r.calls.bashShare).toBeCloseTo(0.4);
  });

  it('excludes the synthetic result-bytes row from the call denominator', () => {
    // It is a COST row, not a call — counting it would deflate the share with
    // something that is not a tool_use block at all.
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', calls: 50 }),
        usageRow({ toolName: 'Read', calls: 50 }),
        usageRow({ toolName: RESULT_BYTES_TOOL, resultBytes: 4000 }),
      ],
      counterparts: [],
      registry: [],
      baselineOf: noBaseline,
    });
    expect(r.calls.total).toBe(100);
    expect(r.calls.bashShare).toBeCloseTo(0.5);
    expect(r.cost).toMatchObject({ resultBytes: 4000, estimatedResultTokens: 1000 });
  });

  it('never counts verb or bucket rows as calls', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', calls: 10 }),
        usageRow({ toolName: 'Bash', verb: 'sed', atoms: 99 }),
        usageRow({ toolName: 'Bash', intentLabel: 'file-range-read', atoms: 77 }),
      ],
      counterparts: [],
      registry: [],
      baselineOf: noBaseline,
    });
    expect(r.calls.total).toBe(10);
  });

  it('reports a null share for an empty window rather than 0%', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7, usage: [], counterparts: [], registry: [], baselineOf: noBaseline,
    });
    expect(r.calls.bashShare).toBeNull();
  });
});

describe('summarizeSubstitutionReport — buckets', () => {
  const registry = [
    regRow(),
    regRow({ intentLabel: 'git-state-read', toolName: 'capability:git' }),
  ];
  const usage = [
    usageRow({ toolName: 'Bash', calls: 100 }),
    usageRow({ toolName: 'Bash', intentLabel: 'file-range-read', atoms: 30, sessions: 5 }),
  ];
  const counterparts: CounterpartRow[] = [{ toolName: 'capability:read', calls: 10, spawns: 3 }];

  it('pairs bash atoms with the counterpart tool and rates the split', () => {
    const r = summarizeSubstitutionReport({ sinceDays: 7, usage, counterparts, registry, baselineOf: noBaseline });
    const b = r.buckets.find((x) => x.intentLabel === 'file-range-read')!;
    expect(b).toMatchObject({ bashAtoms: 30, toolCalls: 10, sessions: 5, toolName: 'capability:read' });
    expect(b.substitutionRate).toBeCloseTo(10 / 40);
  });

  it('reports null (not 0%) for an intent that never occurred on either side', () => {
    // 0% would read as "the tool is being ignored"; the truth is "nobody needed
    // this intent this window", which is not a failure to report.
    const r = summarizeSubstitutionReport({ sinceDays: 7, usage, counterparts, registry, baselineOf: noBaseline });
    const b = r.buckets.find((x) => x.intentLabel === 'git-state-read')!;
    expect(b).toMatchObject({ bashAtoms: 0, toolCalls: 0 });
    expect(b.substitutionRate).toBeNull();
  });

  it('orders buckets by bash volume — the biggest remaining target first', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', intentLabel: 'file-range-read', atoms: 5 }),
        usageRow({ toolName: 'Bash', intentLabel: 'git-state-read', atoms: 50 }),
      ],
      counterparts: [], registry, baselineOf: noBaseline,
    });
    expect(r.buckets.map((b) => b.intentLabel)).toEqual(['git-state-read', 'file-range-read']);
  });

  it('flags an empty registry instead of silently reporting zero buckets', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7, usage, counterparts, registry: [], baselineOf: noBaseline,
    });
    expect(r.emptyRegistry).toBe(true);
    expect(r.buckets).toEqual([]);
  });
});

describe('summarizeSubstitutionReport — window honesty', () => {
  it('marks a window PARTIAL when the rollup holds fewer days than requested', () => {
    // The rollup only counts forward from when it went live, so an early 7-day
    // request really covers 1 day. Comparing that to the 7d frozen baseline
    // without saying so would manufacture a fake improvement.
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [usageRow({ toolName: 'Bash', calls: 10, firstDay: DAY, lastDay: DAY })],
      counterparts: [], registry: [], baselineOf: noBaseline,
    });
    expect(r.coverage).toMatchObject({ requestedDays: 7, daysWithData: 1, partial: true, firstDay: DAY, lastDay: DAY });
  });
});

describe('topVerbs', () => {
  it('ranks verbs by atoms and is capped', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', verb: 'grep', atoms: 100 }),
        usageRow({ toolName: 'Bash', verb: 'sed', atoms: 5 }),
        usageRow({ toolName: 'Bash', verb: 'cat', atoms: 50 }),
      ],
      counterparts: [], registry: [], baselineOf: noBaseline, topVerbLimit: 2,
    });
    expect(r.topVerbs).toEqual([{ verb: 'grep', atoms: 100 }, { verb: 'cat', atoms: 50 }]);
  });
});

describe('frozenBaselineOf', () => {
  it('resolves a real intent to its committed 7d fixture baseline', () => {
    // The P-029 before-number. Mapped via ALL_PAIRS, so a new audited pair
    // brings its baseline with it.
    const b = frozenBaselineOf('file-range-read');
    expect(b).not.toBeNull();
    expect(b!.atoms).toBeGreaterThan(0);
    expect(b!.sessions).toBeGreaterThan(0);
    expect(b!.extractedAt).toMatch(/^2026-/);
  });

  it('returns null for an intent with no fixture rather than inventing a zero', () => {
    expect(frozenBaselineOf('no-such-intent-xyz')).toBeNull();
  });
});

describe('clampReportSinceDays', () => {
  it('defaults to 7 and clamps to [1, 90]', () => {
    expect(clampReportSinceDays(undefined)).toBe(7);
    expect(clampReportSinceDays(0)).toBe(7);
    expect(clampReportSinceDays(-3)).toBe(7);
    expect(clampReportSinceDays(9999)).toBe(90);
    expect(clampReportSinceDays(14)).toBe(14);
  });
});

describe('gradeSubstitution', () => {
  const bigWindow = (rate: number): Parameters<typeof gradeSubstitution>[0] =>
    summarizeSubstitutionReport({
      sinceDays: 7,
      usage: [
        usageRow({ toolName: 'Bash', calls: 500 }),
        usageRow({ toolName: 'Bash', intentLabel: 'file-range-read', atoms: Math.round(100 * (1 - rate)) }),
      ],
      counterparts: [{ toolName: 'capability:read', calls: Math.round(100 * rate), spawns: 5 }],
      registry: [regRow()],
      baselineOf: noBaseline,
    });

  it('is unknown on an empty registry', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7, usage: [usageRow({ toolName: 'Bash', calls: 500 })],
      counterparts: [], registry: [], baselineOf: noBaseline,
    });
    expect(gradeSubstitution(r).rating).toBe('unknown');
  });

  it('is unknown on too thin a window rather than grading noise', () => {
    const r = summarizeSubstitutionReport({
      sinceDays: 7, usage: [usageRow({ toolName: 'Bash', calls: 3 })],
      counterparts: [], registry: [regRow()], baselineOf: noBaseline,
    });
    expect(gradeSubstitution(r).rating).toBe('unknown');
  });

  it('grades on bucket substitution, not the aggregate share (D-006)', () => {
    expect(gradeSubstitution(bigWindow(0.8)).rating).toBe('healthy');
    expect(gradeSubstitution(bigWindow(0.4)).rating).toBe('degraded');
    expect(gradeSubstitution(bigWindow(0.05)).rating).toBe('broken');
  });

  it('says so in the evidence when the window is partial', () => {
    expect(gradeSubstitution(bigWindow(0.8)).evidence).toContain('PARTIAL');
  });
});

describe('readSubstitutionReport', () => {
  it('queries the rollup under the CORPUS namespace, not a tenant id', async () => {
    const seen: Array<{ q: string; p: unknown[] }> = [];
    const runQuery = (async (q: string, p: unknown[]) => {
      seen.push({ q, p });
      return [];
    }) as Parameters<typeof readSubstitutionReport>[0];
    await readSubstitutionReport(runQuery, [regRow()], { sinceDays: 7 });
    expect(seen[0].p[0]).toBe(ROLLUP_CORPUS_WORKSPACE);
    expect(seen[0].p[1]).toBe(7);
  });

  it('asks tool_invocations only about the tools the registry names', async () => {
    const seen: Array<{ q: string; p: unknown[] }> = [];
    const runQuery = (async (q: string, p: unknown[]) => {
      seen.push({ q, p });
      return [];
    }) as Parameters<typeof readSubstitutionReport>[0];
    await readSubstitutionReport(
      runQuery,
      [regRow(), regRow({ intentLabel: 'git-state-read', toolName: 'capability:git' })],
      {},
    );
    expect(seen[1].p[1]).toEqual(['capability:read', 'capability:git']);
  });

  it('still reports the bash side when the counterpart query fails', async () => {
    // The bash number is what P-029 tracks; losing the comparison half must not
    // lose it.
    let call = 0;
    const runQuery = (async () => {
      call += 1;
      if (call === 1) {
        return [{
          tool_name: 'Bash', verb: '', intent_label: '',
          calls: 42, atoms: 0, result_bytes: 0, sessions: 3, first_day: DAY, last_day: DAY,
        }];
      }
      throw new Error('tool_invocations unavailable');
    }) as Parameters<typeof readSubstitutionReport>[0];
    const r = await readSubstitutionReport(runQuery, [regRow()], {});
    expect(r.calls.bash).toBe(42);
    expect(r.buckets[0].toolCalls).toBe(0);
  });
});
