/**
 * schema-version — D-024 gate tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  acceptOpVersion,
  schemaVersionEvents,
  _resetForTests,
  type SchemaVersionAlert,
} from '../schema-version';

afterEach(() => _resetForTests());

describe('acceptOpVersion', () => {
  it('accepts ops with no schema_version (legacy)', () => {
    expect(acceptOpVersion('slug', undefined)).toBe(true);
  });

  it('accepts ops at the current known version', () => {
    expect(acceptOpVersion('slug', CURRENT_SCHEMA_VERSION)).toBe(true);
  });

  it('rejects ops with newer-than-known schema_version', () => {
    expect(acceptOpVersion('slug', CURRENT_SCHEMA_VERSION + 1)).toBe(false);
  });

  it('emits alert exactly once per (slug, version)', () => {
    const alerts: SchemaVersionAlert[] = [];
    schemaVersionEvents.on('alert', (a) => alerts.push(a));
    expect(acceptOpVersion('s1', 99)).toBe(false);
    expect(acceptOpVersion('s1', 99)).toBe(false);
    expect(acceptOpVersion('s1', 99)).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toEqual({
      harnessSlug: 's1',
      observed_version: 99,
      known_version: CURRENT_SCHEMA_VERSION,
    });
  });

  it('alerts independently per (slug, version)', () => {
    const alerts: SchemaVersionAlert[] = [];
    schemaVersionEvents.on('alert', (a) => alerts.push(a));
    acceptOpVersion('s1', 99);
    acceptOpVersion('s2', 99);
    acceptOpVersion('s1', 100);
    expect(alerts).toHaveLength(3);
  });
});
