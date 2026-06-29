import { describe, expect, it } from 'vitest';
import type { RollupTest } from '../../harness-test-rollup';
import {
  detectDoneWithoutTest,
  type DoneItemAssertion,
  type DoneWorkItem,
} from './done-without-test-detect';

const passing = (covers: string[]): RollupTest => ({ coversVALs: covers, status: 'passing' });
const failing = (covers: string[]): RollupTest => ({ coversVALs: covers, status: 'failing' });

describe('done-without-test detector (enforce-system-on-generic-work P-009)', () => {
  it('flags a done work-item whose required VAL has NO passing covering test', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'papercusp', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [{ planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' }];
    const findings = detectDoneWithoutTest(items, assertions, []); // no tests at all
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('done-without-test');
    expect(findings[0].key).toBe('papercusp');
    expect(findings[0].scope).toBe('harness:papercusp');
    expect(findings[0].severity).toBe('major');
    expect(findings[0].findingClass).toBe('test-gate:done-without-test');
    expect(findings[0].count).toBe(1);
    expect(findings[0].workItemIds).toEqual(['F-1']);
    expect(findings[0].body).toContain('F-1');
  });

  it('does NOT flag when every required VAL has a passing covering test', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [{ planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' }];
    expect(detectDoneWithoutTest(items, assertions, [passing(['VAL-1'])])).toEqual([]);
  });

  it('flags when a covering test exists but is FAILING (not passing)', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [{ planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' }];
    const findings = detectDoneWithoutTest(items, assertions, [failing(['VAL-1'])]);
    expect(findings.map((f) => f.count)).toEqual([1]);
  });

  it('does NOT flag a done item that requires NO test (no requires_test assertions)', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    // No assertions for the item ⇒ valsRequiringTest = 0 ⇒ never flagged.
    expect(detectDoneWithoutTest(items, [], [])).toEqual([]);
  });

  it('flags only when SOME (not all) required VALs are unproven', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' },
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-2' },
    ];
    // VAL-1 passing, VAL-2 uncovered ⇒ valsPassing(1) < valsRequiringTest(2) ⇒ flagged.
    const findings = detectDoneWithoutTest(items, assertions, [passing(['VAL-1'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].count).toBe(1);
  });

  it('aggregates required VALs across ALL of a work-item’s plan-items', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001', 'P-002'] },
    ];
    const assertions: DoneItemAssertion[] = [
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' }, // proven
      { planSlug: 'plan-a', itemId: 'P-002', valId: 'VAL-2' }, // unproven
    ];
    const findings = detectDoneWithoutTest(items, assertions, [passing(['VAL-1'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].workItemIds).toEqual(['F-1']);
  });

  it('does not let a DIFFERENT plan’s same item_id satisfy coverage (composite key)', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-A' }, // plan-a's P-001 — unproven
      { planSlug: 'plan-b', itemId: 'P-001', valId: 'VAL-B' }, // plan-b's P-001 — proven, must NOT count
    ];
    const findings = detectDoneWithoutTest(items, assertions, [passing(['VAL-B'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].count).toBe(1);
  });

  it('rolls multiple flagged items in a harness into ONE finding with the per-harness count', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-001'] },
      { workItemId: 'F-2', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-002'] },
      { workItemId: 'F-3', harnessSlug: 'h', planSlug: 'plan-a', planItemIds: ['P-003'] }, // healthy
    ];
    const assertions: DoneItemAssertion[] = [
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' },
      { planSlug: 'plan-a', itemId: 'P-002', valId: 'VAL-2' },
      { planSlug: 'plan-a', itemId: 'P-003', valId: 'VAL-3' },
    ];
    const findings = detectDoneWithoutTest(items, assertions, [passing(['VAL-3'])]);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe('h');
    expect(findings[0].count).toBe(2);
    expect(findings[0].workItemIds).toEqual(['F-1', 'F-2']);
  });

  it('emits a separate finding per harness', () => {
    const items: DoneWorkItem[] = [
      { workItemId: 'F-1', harnessSlug: 'a', planSlug: 'plan-a', planItemIds: ['P-001'] },
      { workItemId: 'F-2', harnessSlug: 'b', planSlug: 'plan-b', planItemIds: ['P-001'] },
    ];
    const assertions: DoneItemAssertion[] = [
      { planSlug: 'plan-a', itemId: 'P-001', valId: 'VAL-1' },
      { planSlug: 'plan-b', itemId: 'P-001', valId: 'VAL-2' },
    ];
    const findings = detectDoneWithoutTest(items, assertions, []);
    expect(findings.map((f) => f.key).sort()).toEqual(['a', 'b']);
  });

  it('returns nothing for empty input', () => {
    expect(detectDoneWithoutTest([], [], [])).toEqual([]);
  });
});
