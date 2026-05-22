/**
 * Unit coverage for the P-019 pure helpers — `rowSessionTag` decides
 * which revision rows expose the "Open conversation" button vs. a
 * tag, and `unavailableReason` renders the in-modal explanation when
 * the verb returned `available: false`.
 */
import { describe, expect, it } from 'vitest';
import {
  rowSessionTag,
  unavailableReason,
} from './RevisionConversationModal';

describe('rowSessionTag', () => {
  it('plan_run + sessionId → null (button shown)', () => {
    expect(rowSessionTag('abc', 'plan_run')).toBeNull();
  });

  it('plan_run without sessionId → "plan-run session missing"', () => {
    // Anomaly — the writer recorded the kind but lost the id.
    expect(rowSessionTag(null, 'plan_run')).toBe('plan-run session missing');
  });

  it('git_backfill → "from git history"', () => {
    expect(rowSessionTag(null, 'git_backfill')).toBe('from git history');
  });

  it('null sessionKind → "direct edit"', () => {
    expect(rowSessionTag(null, null)).toBe('direct edit');
  });

  it('reserved operator_chat / agent_chat → "(not shown)" suffix', () => {
    expect(rowSessionTag('s1', 'operator_chat')).toBe('operator chat (not shown)');
    expect(rowSessionTag('s2', 'agent_chat')).toBe('agent chat (not shown)');
  });
});

describe('unavailableReason', () => {
  it('no_session → direct-edit phrasing', () => {
    expect(unavailableReason('no_session')).toMatch(/direct edit/i);
  });

  it('git_backfill → git-history phrasing', () => {
    expect(unavailableReason('git_backfill')).toMatch(/git history/i);
  });

  it('session_kind_unsupported → not-yet-readable phrasing', () => {
    expect(unavailableReason('session_kind_unsupported')).toMatch(/not yet/i);
  });
});
