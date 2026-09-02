/**
 * Unit tests for correction-decay (P-019 — D-104's endgame check).
 *
 * The suite that matters most here is `anti-correlation control`. This module's entire
 * design rests on one claim — that a rejection-keyed rate would read a FALSE decay where
 * the shape-keyed rate reads none — and a claim that is only argued in a docblock is a
 * claim nobody can falsify later. So the wrong implementation is kept permanently in this
 * file as a control and run against the SAME fixture: it must disagree, in the specific
 * direction the docblock predicts. If the two ever agree, either the fixture stopped
 * exercising the transition or the design premise was wrong; both should fail loudly.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CORRECTION_DECAY_PROBES,
  CORRECTION_DECAY_RELATIVE_DROP_PCT,
  correctionShapeDailySql,
  describeCorrectionPromotion,
  gradeCorrectionDecay,
  readCorrectionShapeDays,
  rollupCorrectionShape,
  splitOnCoercionLive,
  type CorrectionShapeDayRow,
} from './correction-decay';

const RULE = CORRECTION_DECAY_PROBES[0]!.rule;

/** A day row with sane defaults, so each test states only what it is about. */
function day(
  d: string,
  fieldCalls: number,
  coercedCalls: number,
  extra: Partial<CorrectionShapeDayRow> = {},
): CorrectionShapeDayRow {
  return {
    rule: RULE,
    day: d,
    fieldCalls,
    coercedCalls,
    coercedOkCalls: 0,
    distinctOwners: Math.min(coercedCalls, 40),
    ...extra,
  };
}

/**
 * The fixture every verdict test shares: 4 pre-correction days at ~10%, then the rule
 * starts serving on 08-25 (the first day with a coerced call recorded `ok`) and callers
 * keep sending the coerced shape at the same rate.
 */
function stableFixture(): CorrectionShapeDayRow[] {
  return [
    day('2026-08-21', 1000, 100),
    day('2026-08-22', 1000, 100),
    day('2026-08-23', 1000, 100),
    day('2026-08-24', 1000, 100),
    day('2026-08-25', 1000, 100, { coercedOkCalls: 100 }),
    day('2026-08-26', 1000, 100, { coercedOkCalls: 100 }),
    day('2026-08-27', 1000, 100, { coercedOkCalls: 100 }),
    day('2026-08-28', 1000, 100, { coercedOkCalls: 100 }),
  ];
}

describe('splitOnCoercionLive', () => {
  it('derives the live day from the first coerced call recorded ok, not from configuration', () => {
    const split = splitOnCoercionLive(stableFixture());
    expect(split.liveFrom).toBe('2026-08-25');
    expect(split.baseline.map((r) => r.day)).toEqual([
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
      '2026-08-24',
    ]);
    expect(split.current).toHaveLength(4);
  });

  it('takes the EARLIEST ok day even when rows arrive out of order', () => {
    const rows = [...stableFixture()].reverse();
    expect(splitOnCoercionLive(rows).liveFrom).toBe('2026-08-25');
  });

  it('reports null — never a guessed pivot — when the rule has never been observed serving', () => {
    const rows = stableFixture().map((r) => ({ ...r, coercedOkCalls: 0 }));
    const split = splitOnCoercionLive(rows);
    expect(split.liveFrom).toBeNull();
    expect(split.current).toHaveLength(0);
    expect(split.baseline).toHaveLength(8);
  });
});

describe('rollupCorrectionShape verdicts', () => {
  it('says not-yet-live (never healthy) while the correction has not shipped', () => {
    const rows = stableFixture().map((r) => ({ ...r, coercedOkCalls: 0 }));
    const roll = rollupCorrectionShape(rows);
    expect(roll.rules[0]!.verdict).toBe('not-yet-live');
    expect(roll.notDecaying).toHaveLength(0);
    expect(roll.rules[0]!.because).toContain('has not been observed serving');
    // The pre-correction baseline is still reported: it is the thing worth carrying.
    expect(roll.rules[0]!.baseline.pct).toBe(10);
  });

  it('flags not-decaying when callers keep sending the coerced shape', () => {
    const roll = rollupCorrectionShape(stableFixture());
    const row = roll.rules[0]!;
    expect(row.verdict).toBe('not-decaying');
    expect(row.coercionLiveFrom).toBe('2026-08-25');
    expect(row.baseline.pct).toBe(10);
    expect(row.current.pct).toBe(10);
    expect(row.relativeDropPct).toBe(0);
    expect(roll.notDecaying).toHaveLength(1);
  });

  it('says decaying once the coerced share falls past the bar', () => {
    const rows = stableFixture().map((r) =>
      r.day >= '2026-08-25' ? { ...r, coercedCalls: 20 } : r,
    );
    const row = rollupCorrectionShape(rows).rules[0]!;
    expect(row.verdict).toBe('decaying');
    expect(row.relativeDropPct).toBe(80);
  });

  it('holds the measured bar: a drop smaller than it is NOT decay', () => {
    // 10% -> 6% is a 40% relative drop, inside the 25.9% no-intervention drift band
    // doubled. It must stay `not-decaying`, or ordinary fleet churn files a promotion.
    const rows = stableFixture().map((r) =>
      r.day >= '2026-08-25' ? { ...r, coercedCalls: 60 } : r,
    );
    const row = rollupCorrectionShape(rows).rules[0]!;
    expect(row.relativeDropPct).toBe(40);
    expect(row.relativeDropPct!).toBeLessThan(CORRECTION_DECAY_RELATIVE_DROP_PCT);
    expect(row.verdict).toBe('not-decaying');
  });

  it('refuses to grade on thin traffic instead of reporting a confident 0%', () => {
    // The live shape of the trap: 2 coerced calls out of 246 on a quiet day reads as
    // 0.8% and looks like total decay. Every day here is below the per-day floor.
    const rows = [
      day('2026-08-21', 15, 2),
      day('2026-08-22', 15, 2),
      day('2026-08-23', 15, 2),
      day('2026-08-24', 15, 0, { coercedOkCalls: 0 }),
      day('2026-08-25', 15, 1, { coercedOkCalls: 1 }),
      day('2026-08-26', 15, 0, { coercedOkCalls: 0 }),
    ];
    const row = rollupCorrectionShape(rows).rules[0]!;
    expect(row.verdict).toBe('insufficient-data');
    expect(row.because).toContain('counted days');
  });

  it('dedupes (rule, day) so replaying a snapshotted day cannot double-count it', () => {
    const rows = [...stableFixture(), ...stableFixture()];
    const row = rollupCorrectionShape(rows).rules[0]!;
    expect(row.baseline.fieldCalls).toBe(4000);
    expect(row.current.fieldCalls).toBe(4000);
    expect(rollupCorrectionShape(rows).daysSeen).toBe(8);
  });

  it('reports a registered rule with no data at all rather than omitting it', () => {
    const roll = rollupCorrectionShape([]);
    expect(roll.rules.map((r) => r.rule)).toEqual(CORRECTION_DECAY_PROBES.map((p) => p.rule));
    expect(roll.rules[0]!.verdict).toBe('not-yet-live');
  });
});

describe('anti-correlation control (D-109 / D-113)', () => {
  /**
   * The WRONG implementation, kept deliberately: the obvious decay check, keyed on
   * rejection status rather than on the shape callers sent. Never used in production —
   * its only job is to be run beside the real one and disagree.
   */
  function rejectionKeyedRate(rows: readonly CorrectionShapeDayRow[]): {
    baselinePct: number;
    currentPct: number;
  } {
    const pct = (subset: readonly CorrectionShapeDayRow[]): number => {
      const calls = subset.reduce((n, r) => n + r.fieldCalls, 0);
      // A rejection-keyed check can only see the calls that were REFUSED.
      const rejected = subset.reduce((n, r) => n + (r.coercedCalls - r.coercedOkCalls), 0);
      return calls === 0 ? 0 : Math.round((1000 * rejected) / calls) / 10;
    };
    const split = splitOnCoercionLive(rows);
    return { baselinePct: pct(split.baseline), currentPct: pct(split.current) };
  }

  it('the status-keyed rate reads a FALSE total decay on data where caller behaviour never changed', () => {
    const rows = stableFixture();
    // Ground truth in the fixture: callers send the coerced shape at exactly 10% on
    // every single day, before and after the rule started serving.
    for (const r of rows) expect(r.coercedCalls / r.fieldCalls).toBe(0.1);

    const wrong = rejectionKeyedRate(rows);
    expect(wrong.baselinePct).toBe(10);
    expect(wrong.currentPct).toBe(0); // <- the false decay, exactly as predicted

    const right = rollupCorrectionShape(rows).rules[0]!;
    expect(right.baseline.pct).toBe(10);
    expect(right.current.pct).toBe(10);
    expect(right.verdict).toBe('not-decaying');
  });

  it('CALIBRATION: on a genuine decay the two agree, so the disagreement above is the transition and not a broken control', () => {
    // Callers really do stop sending it AND the rule is serving: both instruments fall.
    const rows = stableFixture().map((r) =>
      r.day >= '2026-08-25' ? { ...r, coercedCalls: 10, coercedOkCalls: 10 } : r,
    );
    const wrong = rejectionKeyedRate(rows);
    const right = rollupCorrectionShape(rows).rules[0]!;
    expect(right.verdict).toBe('decaying');
    expect(wrong.currentPct).toBeLessThan(wrong.baselinePct);
    expect(right.current.pct).toBeLessThan(right.baseline.pct);
  });
});

describe('gradeCorrectionDecay', () => {
  it('grades a permanent correction degraded, and names it', () => {
    const grade = gradeCorrectionDecay(rollupCorrectionShape(stableFixture()));
    expect(grade.rating).toBe('degraded');
    expect(grade.promotionCandidates).toEqual([RULE]);
    expect(grade.evidence).toContain(RULE);
  });

  it('never pages: there is no broken rating even for a wholly permanent correction', () => {
    const rows = stableFixture().map((r) => ({ ...r, coercedCalls: r.fieldCalls }));
    const grade = gradeCorrectionDecay(rollupCorrectionShape(rows));
    expect(['healthy', 'degraded', 'unknown']).toContain(grade.rating);
    expect(grade.rating).not.toBe('broken');
  });

  it('reports unknown — with the reason — while nothing is gradeable yet', () => {
    const rows = stableFixture().map((r) => ({ ...r, coercedOkCalls: 0 }));
    const grade = gradeCorrectionDecay(rollupCorrectionShape(rows));
    expect(grade.rating).toBe('unknown');
    expect(grade.evidence).toContain('has not been observed serving');
    expect(grade.promotionCandidates).toEqual([]);
  });

  it('grades a decaying correction healthy and proposes nothing', () => {
    const rows = stableFixture().map((r) =>
      r.day >= '2026-08-25' ? { ...r, coercedCalls: 10, coercedOkCalls: 10 } : r,
    );
    const grade = gradeCorrectionDecay(rollupCorrectionShape(rows));
    expect(grade.rating).toBe('healthy');
    expect(grade.promotionCandidates).toEqual([]);
  });
});

describe('describeCorrectionPromotion', () => {
  it('carries both windows, the recommendation, and the scope note that stops a status re-read', () => {
    const row = rollupCorrectionShape(stableFixture()).rules[0]!;
    const finding = describeCorrectionPromotion(row);
    expect(finding.watchdogKey).toBe(`correction-decay:${RULE}`);
    expect(finding.title).toContain(RULE);
    expect(finding.body).toContain('2026-08-25');
    expect(finding.body).toContain('promote the coerced shape');
    expect(finding.body).toContain('retire the original');
    expect(finding.body).toContain('args_json');
    expect(finding.body).toContain('never from `status`');
  });
});

describe('correctionShapeDailySql', () => {
  const sql = correctionShapeDailySql(CORRECTION_DECAY_PROBES[0]!);

  it('parameterises the tenant scope and the window, and never interpolates them', () => {
    expect(sql).toContain('workspace_id = $1');
    expect(sql).toContain("(($2)::int || ' days')::interval");
  });

  it('reads the sent shape out of args_json and uses status only for the ok-day pivot', () => {
    expect(sql).toContain('args_json::jsonb');
    // Exactly one status reference, and it is the coercion-live pivot column.
    const statusRefs = sql.match(/status\s*=\s*'ok'/g) ?? [];
    expect(statusRefs).toHaveLength(1);
    expect(sql).not.toContain("'invalid-input'");
  });

  it('counts BOTH places the verb can carry the field — body[] and items[].body[]', () => {
    expect(sql).toContain("c.a->'body'");
    expect(sql).toContain("c.a->'items'");
    expect(sql).toContain("it->'body'");
  });
});

describe('readCorrectionShapeDays', () => {
  it('maps string-typed pg counts to numbers and stamps the rule', async () => {
    const runQuery = (async () => [
      {
        day: '2026-08-21',
        field_calls: '1000',
        coerced_calls: '100',
        coerced_ok_calls: '0',
        distinct_owners: '40',
      },
    ]) as Parameters<typeof readCorrectionShapeDays>[0];
    const rows = await readCorrectionShapeDays(runQuery, CORRECTION_DECAY_PROBES[0]!, {
      workspaceId: 'w',
    });
    expect(rows).toEqual([
      {
        rule: RULE,
        day: '2026-08-21',
        fieldCalls: 1000,
        coercedCalls: 100,
        coercedOkCalls: 0,
        distinctOwners: 40,
      },
    ]);
  });
});

describe('probe coverage (derived-truth PIN)', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

  /**
   * Every `ArgReencoding` declared in the tree must have a decay probe, or a rule ships
   * unmeasured and D-104's endgame clause silently stops applying to it.
   *
   * Derived by scanning the working tree rather than by keeping a second hand-written
   * list: a hand-written list is exactly the drift this asserts against. `grep -rl` (not
   * a bounded/`head`-piped search) because the conclusion drawn from it is an ABSENCE —
   * a truncated search would manufacture the clean result.
   */
  function declaredReencodingFiles(): string[] {
    let out = '';
    try {
      out = execFileSync(
        'grep',
        [
          '-rlF',
          '--include=*.ts',
          ': ArgReencoding = {',
          'packages/operator-core/lib',
          'packages/agent-mcp/src',
          'libs/generic/tooldef/src',
        ],
        { cwd: repoRoot, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
      );
    } catch (e) {
      // grep exits 1 on "no matches" — a real answer, not a failure.
      const status = (e as { status?: number }).status;
      if (status !== 1) throw e;
    }
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.endsWith('.test.ts'));
  }

  it('finds the declaration sites at all (positive control for the scan itself)', () => {
    // Without this, a scan that silently matched nothing would make the assertion below
    // vacuously pass — the failure mode a zero-result search always has.
    expect(declaredReencodingFiles().length).toBeGreaterThan(0);
  });

  it('registers exactly one probe per declared re-encoding rule', () => {
    const files = declaredReencodingFiles();
    expect(
      CORRECTION_DECAY_PROBES.length,
      `Declared ArgReencoding sites:\n  ${files.join('\n  ')}\n` +
        `Registered probes: ${CORRECTION_DECAY_PROBES.map((p) => p.rule).join(', ')}\n` +
        'A new re-encoding rule needs a probe in CORRECTION_DECAY_PROBES, or its decay is never measured.',
    ).toBe(files.length);
  });

  it('takes each probe rule id from the module that declares it, never a retyped literal', async () => {
    const { PREMISES_REENCODING_RULE, PREMISES_REF_OBJECT_REENCODING } = await import(
      './agent-tools/coordination/message-fields'
    );
    expect(CORRECTION_DECAY_PROBES.map((p) => p.rule)).toContain(PREMISES_REENCODING_RULE);
    expect(PREMISES_REF_OBJECT_REENCODING.rule).toBe(PREMISES_REENCODING_RULE);
  });
});
