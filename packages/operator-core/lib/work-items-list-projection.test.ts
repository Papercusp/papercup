/**
 * WI-42508 — the feature-family list projection must be a real SQL projection,
 * not a post-handler trim.  The integration suite exercises the query against
 * Postgres; these pure assertions keep the derived column list from silently
 * drifting when FEATURE_COLS grows.
 */
import { describe, expect, it } from 'vitest';
import { FEATURE_COLS, FEATURE_COLS_PAYLOADLESS, featureRowToWorkItem } from './work-items';

const cols = (s: string) =>
  s
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

describe('WI-42508 feature-family list projection', () => {
  it('keeps the full row arity/order and aliases payload to the original key', () => {
    const full = cols(FEATURE_COLS);
    const lean = cols(FEATURE_COLS_PAYLOADLESS);
    expect(lean.length).toBe(full.length);
    expect(lean).not.toContain('payload');
    expect(FEATURE_COLS_PAYLOADLESS).toContain('NULL::jsonb AS payload');
    const differing = full
      .map((c, i) => [c, lean[i]] as const)
      .filter(([before, after]) => before !== after);
    expect(differing).toEqual([['payload', 'NULL::jsonb AS payload']]);
  });

  it('maps a payloadless row without attempting JSON parsing', () => {
    const row = featureRowToWorkItem({
      feature_id: 'WI-42508-feature',
      item_kind: 'feature',
      harness_slug: 'papercusp',
      title: 'lean',
      summary: 'summary',
      status: 'open',
      taken_by: null,
      taken_at: null,
      last_progress_at: null,
      parent_id: null,
      payload: null,
      assignee_rank: null,
      rank_writer: null,
      rank_updated_at: null,
      feature_order: null,
      created_ts: '2026-08-27 10:00:00+00',
      updated_ts: '2026-08-27 10:00:00+00',
      origin: 'local',
      audit_verdict: null,
      verified_author_github_user_id: null,
      terminal_owner: null,
      terminal_completion_ref: null,
      authority: null,
      closed_ts: null,
      goal_id: null,
      tags: null,
      source_plan_slug: null,
      source_plan_item_ids: null,
      redundancy: null,
      expected_cost_cents: null,
    });
    expect(row.payload).toBeNull();
    expect(row.terminalCompletionEvidence).toBeNull();
    expect(row.summary).toBe('summary');
  });
});
