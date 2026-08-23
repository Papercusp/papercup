/**
 * Regression coverage for the legacy feature PATCH terminal path.
 *
 * The PATCH writer clears `taken_by` before the detached settled-event read.
 * Keep the pre-clear holder extraction pinned here; the settled-event fanout
 * already has direct coverage for attributing a terminal item to that holder.
 */
import { describe, expect, it } from 'vitest';
import { priorFeatureAssignee } from '../routes/harness/features';

describe('legacy feature terminal completion', () => {
  it('captures the pre-clear feature holder from taken_by', () => {
    expect(
      priorFeatureAssignee({ taken_by: 'su-holder', assignee: null }),
    ).toBe('su-holder');
  });

  it('accepts the compatibility assignee field when taken_by is absent', () => {
    expect(
      priorFeatureAssignee({ taken_by: null, assignee: 'su-holder' }),
    ).toBe('su-holder');
  });

  it('does not attribute an unassigned feature to a fleet holder', () => {
    expect(
      priorFeatureAssignee({ taken_by: 'unassigned', assignee: null }),
    ).toBeNull();
  });
});
