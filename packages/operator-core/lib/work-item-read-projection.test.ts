import { describe, expect, it } from 'vitest';
import { FLEET_METRIC_ARCHIVE_KEYS, projectWorkItemColumns } from './work-item-read-projection';

describe('work-item source read projection', () => {
  const columns = 'id, body, payload, state';

  it('keeps the canonical columns untouched for full reads', () => {
    expect(projectWorkItemColumns(columns)).toBe(columns);
  });

  it('projects a typed NULL payload without changing row arity', () => {
    const projected = projectWorkItemColumns(columns, 'none');
    expect(projected).toBe('id, body, NULL::jsonb AS payload, state');
  });

  it('keeps only completion evidence under the original payload key', () => {
    const projected = projectWorkItemColumns(columns, 'completionEvidence');
    expect(projected).toContain(
      "jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload",
    );
    expect(projected).toBe(
      "id, body, jsonb_build_object('_completionEvidence', payload -> '_completionEvidence') AS payload, state",
    );
  });

  it('does not silently no-op when payload formatting changes', () => {
    expect(projectWorkItemColumns('id,payload,state', 'none')).toContain('NULL::jsonb AS payload');
  });

  it('keeps fleet controls by subtracting only archival keys, preserving malformed shapes', () => {
    const projected = projectWorkItemColumns(columns, 'fleetMetrics');
    expect(projected).toContain("CASE WHEN jsonb_typeof(payload) = 'object'");
    expect(projected).toContain('ELSE payload END) AS payload');
    for (const key of FLEET_METRIC_ARCHIVE_KEYS) expect(projected).toContain(`'${key}'`);
    for (const key of ['agentReview', 'implementationReadiness', '_claimHold', 'externalBlockers',
      'claim_hold_release', 'plan_item', 'ideaLifecycle', 'paths', 'tags']) {
      expect(FLEET_METRIC_ARCHIVE_KEYS as readonly string[]).not.toContain(key);
    }
  });
});
