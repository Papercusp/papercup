import { describe, expect, it } from 'vitest';
import {
  decodeSessionCursor,
  encodeSessionCursor,
  sessionCursorFingerprint,
} from './cursor';

describe('sessions cursor contract', () => {
  it('round-trips a bounded offset and is stable across object key order', () => {
    const fingerprint = sessionCursorFingerprint({ owner: 'su-1', filters: { since: '2026-07-13', kind: 'codex' } });
    expect(fingerprint).toBe(
      sessionCursorFingerprint({ filters: { kind: 'codex', since: '2026-07-13' }, owner: 'su-1' }),
    );
    expect(sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-a' })).not.toBe(
      sessionCursorFingerprint({ owner: 'su-2', workspace_id: 'workspace-a' }),
    );
    expect(sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-a' })).not.toBe(
      sessionCursorFingerprint({ owner: 'su-1', workspace_id: 'workspace-b' }),
    );
    const bounds = { until: '2026-07-14T03:00:00.000Z' };
    const cursor = encodeSessionCursor('sessions:list', 25, fingerprint, bounds);
    expect(decodeSessionCursor(cursor, 'sessions:list', fingerprint)).toEqual({
      ok: true,
      offset: 25,
      bounds,
    });
  });

  it('fails closed across tools, changed filters, malformed values, and oversized offsets', () => {
    const fingerprint = sessionCursorFingerprint({ owner: 'su-1' });
    const cursor = encodeSessionCursor('sessions:list', 10, fingerprint);
    expect(decodeSessionCursor(cursor, 'sessions:search', fingerprint)).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor(cursor, 'sessions:list', sessionCursorFingerprint({ owner: 'su-2' }))).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor('not-json', 'sessions:list', fingerprint)).toEqual({
      ok: false,
      error: 'invalid_cursor',
      message: 'Cursor is malformed.',
    });
    expect(decodeSessionCursor(encodeSessionCursor('sessions:list', 501, fingerprint), 'sessions:list', fingerprint)).toMatchObject({ ok: false, error: 'invalid_cursor' });
    expect(decodeSessionCursor(
      encodeSessionCursor('sessions:list', 10, fingerprint, { until: 'not-a-date' }),
      'sessions:list',
      fingerprint,
    )).toMatchObject({ ok: false, error: 'invalid_cursor' });
  });
});
