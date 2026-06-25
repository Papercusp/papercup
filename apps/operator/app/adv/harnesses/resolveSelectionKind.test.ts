import { describe, it, expect } from 'vitest';
import { resolveSelectionKind } from './DetailPanel';

describe('resolveSelectionKind', () => {
  it('maps F-* ids to the feature detail', () => {
    expect(resolveSelectionKind('F-1234')).toBe('feature');
    expect(resolveSelectionKind('F-CANARY-20260625')).toBe('feature');
  });

  it('maps legacy I-* ids to the issue detail', () => {
    expect(resolveSelectionKind('I-42')).toBe('issue');
  });

  it('maps agent:* ids to the agent detail', () => {
    expect(resolveSelectionKind('agent:su-abc123')).toBe('agent');
  });

  it('maps WI-* ids to the unified work-item detail', () => {
    expect(resolveSelectionKind('WI-767')).toBe('workItem');
  });

  // The regression this guards: non-WI work-item prefixes (the EI-* issue-family
  // items, BA-* bet-analysis, etc.) used to resolve to no kind and render
  // "No item found". They must resolve to the unified work-item detail.
  it('maps EI-* (and other non-WI work-item prefixes) to the work-item detail', () => {
    expect(resolveSelectionKind('EI-3537')).toBe('workItem');
    expect(resolveSelectionKind('BA-9')).toBe('workItem');
    expect(resolveSelectionKind('OTHER-1')).toBe('workItem');
  });

  it('returns null for an empty/absent selection', () => {
    expect(resolveSelectionKind('')).toBeNull();
    expect(resolveSelectionKind(null)).toBeNull();
    expect(resolveSelectionKind(undefined)).toBeNull();
  });
});
