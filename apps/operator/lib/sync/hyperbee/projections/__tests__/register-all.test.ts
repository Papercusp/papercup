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

  it('REGISTERED_PROJECTION_TAGS covers all HYPERBEE_TABLE_TAGS except features-by-status', () => {
    // features-by-status is a derived index, not a separate Hyperbee write
    // target — it shares feature rows with features-by-id, projected once.
    // Confirm parity: registered = key tags minus features-by-status.
    const registered = new Set(REGISTERED_PROJECTION_TAGS);
    const expected = new Set(HYPERBEE_TABLE_TAGS.filter((t) => t !== 'features-by-status'));
    expect(registered).toEqual(expected);
  });

  it('re-running registration overwrites cleanly (idempotent for re-boot)', () => {
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    registerAllHarnessProjections({ workspaceId: 'w', harnessSlug: 'sheets' });
    for (const tag of REGISTERED_PROJECTION_TAGS) {
      expect(getProjection(tag)).not.toBeNull();
    }
  });
});
