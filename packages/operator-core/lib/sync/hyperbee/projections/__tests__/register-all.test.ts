/**
 * register-all — boot-wiring helper tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REGISTERED_PROJECTION_TAGS,
  registerAllHarnessProjections,
} from '../register-all';
import { getProjection, _clearRegistryForTests } from '../../projection';
import { HYPERBEE_TABLE_TAGS } from '../../../../harness/hyperbee-key-types';

beforeEach(() => _clearRegistryForTests());
afterEach(() => _clearRegistryForTests());

describe('registerAllHarnessProjections', () => {
  it('throws on missing workspaceId', () => {
    expect(() =>
      registerAllHarnessProjections({ workspaceId: '', harnessSlug: 's' }),
    ).toThrow(/workspaceId/);
  });

  it('throws on missing harnessSlug', () => {
    expect(() =>
      registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: '' }),
    ).toThrow(/harnessSlug/);
  });

  it('registers exactly the expected tags', () => {
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    for (const tag of REGISTERED_PROJECTION_TAGS) {
      expect(getProjection(tag)).not.toBeNull();
    }
  });

  it('registered tags map to projections whose tableTag matches', () => {
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    for (const tag of REGISTERED_PROJECTION_TAGS) {
      const p = getProjection(tag);
      expect(p?.tableTag).toBe(tag);
    }
  });

  it('REGISTERED_PROJECTION_TAGS covers every dogfood-v5 HYPERBEE_TABLE_TAG except features-by-status (superset allowed)', () => {
    // features-by-status is a derived index, not a separate Hyperbee write
    // target — it shares feature rows with features-by-id, projected once.
    //
    // The invariant is COVERAGE, not equality: REGISTERED_PROJECTION_TAGS is a
    // SUPERSET of the dogfood-v5 prefix-scannable key tags. Newer federated
    // surfaces (coord-conversations from distributed-coordination-shared-harness,
    // item-assignments from plan-item-assignment-claim-liveness, …) are
    // registered projections dispatched by op.table tag — they are NOT v5
    // prefix-scannable key shapes, so they have no HYPERBEE_TABLE_TAGS entry.
    // Asserting equality here flapped red every time a federated table was added
    // (the "strict-set" brittleness class); coverage is the real invariant.
    const registered = new Set(REGISTERED_PROJECTION_TAGS);
    const v5KeyTags = HYPERBEE_TABLE_TAGS.filter((t) => t !== 'features-by-status');
    for (const tag of v5KeyTags) {
      expect(registered.has(tag), `v5 key tag '${tag}' must be a registered projection`).toBe(true);
    }
  });

  it('re-running registration overwrites cleanly (idempotent for re-boot)', () => {
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    for (const tag of REGISTERED_PROJECTION_TAGS) {
      expect(getProjection(tag)).not.toBeNull();
    }
  });
});
