import { describe, expect, it } from 'vitest';
import { buildPresenceProjection, _testing, type SharedPresenceRow } from '../presence';

function p(over: Partial<SharedPresenceRow> = {}): SharedPresenceRow {
  return {
    harness_slug: 'sheets',
    github_user_id: 12345,
    machine_label: 'alice-mbp',
    device_pubkey: 'b'.repeat(64),
    intent: 'editing F-001',
    current_view: '/harness/sheets/feature/F-001',
    last_seen_at: 1700000000000,
    schema_version: 1,
    ...over,
  };
}

describe('shared_presence projection', () => {
  it('composeKey joins github_user_id and machine_label', () => {
    expect(_testing.composeKey(p())).toBe('12345/alice-mbp');
  });

  it('composeKey survives machine labels with slashes', () => {
    // Slash inside the label would be ambiguous; agree on "first slash splits".
    // composeKey itself just concatenates — parsing is in deleteFromPg.
    expect(_testing.composeKey(p({ machine_label: 'alice/laptop' }))).toBe('12345/alice/laptop');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(p())).toEqual(p());
  });

  it('decodeValue accepts intent + current_view as null', () => {
    expect(_testing.decodeValue(p({ intent: null, current_view: null }))).not.toBeNull();
  });

  it('decodeValue rejects empty harness_slug', () => {
    expect(_testing.decodeValue(p({ harness_slug: '' }))).toBeNull();
  });

  it('decodeValue rejects non-integer github_user_id', () => {
    expect(_testing.decodeValue(p({ github_user_id: 12.5 }))).toBeNull();
  });

  it('decodeValue rejects zero github_user_id', () => {
    expect(_testing.decodeValue(p({ github_user_id: 0 }))).toBeNull();
  });

  it('decodeValue rejects empty machine_label', () => {
    expect(_testing.decodeValue(p({ machine_label: '' }))).toBeNull();
  });

  it('decodeValue rejects empty device_pubkey', () => {
    expect(_testing.decodeValue(p({ device_pubkey: '' }))).toBeNull();
  });

  it('decodeValue rejects non-finite last_seen_at', () => {
    expect(_testing.decodeValue({ ...p(), last_seen_at: NaN })).toBeNull();
  });

  it('decodeValue rejects non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('x')).toBeNull();
  });

  it('buildPresenceProjection exposes the presence tag', () => {
    const proj = buildPresenceProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    expect(proj.tableTag).toBe('presence');
  });

  it('deleteFromPg parses key gracefully — bad keys are no-op', async () => {
    const proj = buildPresenceProjection({ workspaceId: 'w', harnessSlug: 'sheets' });
    await expect(proj.deleteFromPg('not-a-key')).resolves.toBeUndefined();
    await expect(proj.deleteFromPg('')).resolves.toBeUndefined();
    await expect(proj.deleteFromPg('abc/host')).resolves.toBeUndefined();
  });
});
