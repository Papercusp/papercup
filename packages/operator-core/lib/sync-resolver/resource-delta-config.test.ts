/**
 * resource-delta-config (agent-tool-delta-client-rollout-2026-06-23 P-006) — the per-sync-
 * resource itemKey config that opts a resource into the rows-delta protocol. Pins the two
 * configured high-cost resources + that an unconfigured one serves full (undefined).
 */
import { describe, it, expect } from 'vitest';
import { resourceDeltaConfig, RESOURCE_DELTA_NAMES } from './resource-delta-config';

describe('resourceDeltaConfig', () => {
  // The schemaVersion literal is pinned ON PURPOSE: changing the projected row
  // shape without bumping it makes in-flight client cursors report the whole
  // view as `updated` instead of taking one clean full. Failing here is the
  // reminder to bump — v1 → v2 was WI-7039/D-025 (null-valued keys omitted).
  it('plans.attention keys on the AttentionGroup `key`', () => {
    expect(resourceDeltaConfig('plans.attention')).toEqual({
      itemKeyField: 'key',
      schemaVersion: 'plans-attention-v2',
    });
  });

  it('plans.list keys on `slug`', () => {
    expect(resourceDeltaConfig('plans.list')?.itemKeyField).toBe('slug');
  });

  // WI-7083: byHive reuses plans.list's read, so it takes the same key. It could not
  // have one before the fan-out was deduped on the resolved plan SCOPE — `slug` had 910
  // distinct values across 1,820 rows because every hive member fabricated its own copy
  // of the home plan set, leaving no unique single field to key on.
  it('plans.byHive keys on `slug`, like the plans.list read it reuses', () => {
    expect(resourceDeltaConfig('plans.byHive')).toEqual({
      itemKeyField: 'slug',
      schemaVersion: 'plans-byhive-v1',
    });
    expect(resourceDeltaConfig('plans.byHive')?.itemKeyField).toBe(
      resourceDeltaConfig('plans.list')?.itemKeyField,
    );
  });

  // The two share a key FIELD but must not share a cursor: rest-query scopes each
  // digest by `${name}:${argsJson}`, and the schemaVersions differ so an in-flight
  // cursor cannot be replayed across them.
  it('plans.byHive and plans.list carry distinct schemaVersions', () => {
    expect(resourceDeltaConfig('plans.byHive')?.schemaVersion).not.toBe(
      resourceDeltaConfig('plans.list')?.schemaVersion,
    );
  });

  it('an unconfigured resource serves full (undefined → no delta)', () => {
    // ANCHORED to the exported set, not hardcoded. This test named `workItems.byHarness`
    // until D-091 gave that resource a config — at which point a correct change reds a test
    // whose subject is "some resource with no config", not that resource specifically. Three
    // separate tests carried that same rot into D-091; asserting non-membership first means a
    // future opt-in fails with "your example opted in" rather than "the lookup is broken".
    const unconfigured = 'hive.steering';
    expect(RESOURCE_DELTA_NAMES).not.toContain(unconfigured);
    expect(resourceDeltaConfig(unconfigured)).toBeUndefined();
  });
});
