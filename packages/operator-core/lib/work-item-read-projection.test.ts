import { describe, expect, it } from 'vitest';
import { projectWorkItemColumns } from './work-item-read-projection';

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
    expect(projected.split(',')).toHaveLength(columns.split(',').length);
  });

  it('does not silently no-op when payload formatting changes', () => {
    expect(projectWorkItemColumns('id,payload,state', 'none')).toContain('NULL::jsonb AS payload');
  });
});
