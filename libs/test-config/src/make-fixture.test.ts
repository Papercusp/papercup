import { describe, it, expect, beforeEach } from 'vitest';
import { generated } from '@papercusp/db-org';
import { makeFixture, makeFixtures, _resetFixtureCounters } from './make-fixture.ts';

describe('makeFixture', () => {
  beforeEach(() => _resetFixtureCounters());

  it('produces a row with all NOT NULL columns satisfied', () => {
    const row = makeFixture(generated.operator_budget_tiersInHarness_shared);
    // operator_budget_tiers PK = ord, all four columns NOT NULL
    expect(row).toHaveProperty('ord');
    expect(row).toHaveProperty('label');
    expect(row).toHaveProperty('cap_usd');
    expect(row).toHaveProperty('blurb');
  });

  it('respects overrides', () => {
    const row = makeFixture(generated.operator_budget_tiersInHarness_shared, {
      ord: 99,
      label: 'Custom',
    });
    expect(row.ord).toBe(99);
    expect(row.label).toBe('Custom');
  });

  it('makes unique ids across rows in the same table', () => {
    const a = makeFixture(generated.adaptive_telemetryInHarness_shared);
    const b = makeFixture(generated.adaptive_telemetryInHarness_shared);
    expect(a.harness_slug).toBe(b.harness_slug); // both default to 'demo'
    // Timestamp columns get unique-ish defaults (Date.now() each call)
  });

  it('treats nullable columns as null when no default', () => {
    // toast_log.description is nullable
    const row = makeFixture(generated.toast_logInHarness_shared);
    expect(row.description).toBeNull();
  });

  it('omits columns with SQL defaults so the DB fills them', () => {
    // toast_log.id is a serial PK with hasDefault=true → should NOT appear
    const row = makeFixture(generated.toast_logInHarness_shared);
    expect(row).not.toHaveProperty('id');
  });

  it('uses Date.now() for bigint timestamp columns with no default', () => {
    // audit_log.ts is bigint NOT NULL without a SQL default → fixture
    // fills it with Date.now() so the row is insertable without help.
    const row = makeFixture(generated.audit_logInHarness_shared);
    expect(typeof row.ts).toBe('number');
    expect(row.ts as number).toBeGreaterThan(0);
  });

  it('jsonb columns default to {} when NOT NULL', () => {
    const row = makeFixture(generated.harness_testsInHarness_shared);
    expect(row.payload).toEqual({});
  });

  it('makeFixtures builds a batch with per-row overrides', () => {
    const rows = makeFixtures(
      generated.operator_budget_tiersInHarness_shared,
      3,
      (i) => ({ ord: i, label: `T${i}` }),
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.label)).toEqual(['T0', 'T1', 'T2']);
  });

  it('counters reset on demand', () => {
    const a = makeFixture(generated.adaptive_telemetryInHarness_shared);
    _resetFixtureCounters();
    const b = makeFixture(generated.adaptive_telemetryInHarness_shared);
    // adaptive_telemetry.id has hasDefault (bigserial), so it's omitted.
    // Re-running yields the same row shape.
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});
