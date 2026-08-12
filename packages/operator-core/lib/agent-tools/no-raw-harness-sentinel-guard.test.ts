/**
 * The sentinel-use detector's teeth and real-tree enforcement.
 *
 * A clean run alone cannot prove this guard catches a future raw identity use;
 * the fixture tests below pin the positive and negative directions, while the
 * final test executes the scanner against the repository.
 */
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no declaration file; keep this import on one line so
// the suppression covers TS7016 on the module specifier.
import { BASELINE, findOffenders, findRawHarnessSentinelUses, findingKey } from '../../../../scripts/check-no-raw-harness-sentinel.mjs';

describe('raw ctx.harnessSlug sentinel detector', () => {
  it('flags a nullish fallback that lets the truthy * sentinel win', () => {
    const [finding] = findRawHarnessSentinelUses(
      'const harness = args.harness ?? ctx.harnessSlug ?? undefined;',
    );
    expect(finding?.kind).toBe('fallback');
  });

  it('flags a raw identity-bearing object field', () => {
    const [finding] = findRawHarnessSentinelUses(
      'const scope = { harnessSlug: ctx.harnessSlug ?? null };',
    );
    expect(finding?.kind).toBe('fallback');
  });

  it('flags a non-sentinel predicate', () => {
    const [finding] = findRawHarnessSentinelUses(
      'if (ctx.harnessSlug === requestedHarness) return true;',
    );
    expect(finding?.kind).toBe('predicate');
  });

  it('does not flag canonical resolver calls', () => {
    expect(
      findRawHarnessSentinelUses(
        'const slug = resolveConcreteHarnessSlug(args.harness, ctx);',
      ),
    ).toEqual([]);
    expect(
      findRawHarnessSentinelUses(
        'const pot = resolvePotHomeSlug(args.harness, ctx.harnessSlug);',
      ),
    ).toEqual([]);
  });

  it('does not flag an explicit sentinel guard and its guarded branch', () => {
    expect(
      findRawHarnessSentinelUses(
        "const slug = ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null;",
      ),
    ).toEqual([]);
  });

  it('ignores prose and string literals', () => {
    expect(
      findRawHarnessSentinelUses(
        "// ctx.harnessSlug ?? '' is the trap\nconst note = 'harnessSlug: ctx.harnessSlug';",
      ),
    ).toEqual([]);
  });

  it('keeps the baseline shrink-only and proves the real tree has no new finding', () => {
    const scan = findOffenders();
    expect(scan.staleBaseline, 'a stale baseline hides a changed or removed site').toEqual([]);
    expect(scan.offenders, 'a new raw identity use must fail the build').toEqual([]);
    for (const key of BASELINE) expect(typeof key).toBe('string');
    expect(BASELINE.size).toBe(66);
  }, 120_000);

  it('uses a source fingerprint in baseline keys', () => {
    expect(
      findingKey('src/a.ts', { line: 4, kind: 'fallback', text: 'const x = 1;' }),
    ).toBe('src/a.ts:4:fallback:const x = 1;');
  });
});
