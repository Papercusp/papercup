/**
 * agent-activity-bus.test.ts — the cross-CLI activity bridge's NOTIFY-payload
 * parser. ownerFromPayload extracts the owner_id from the migration-143 payload
 * `"<workspace_id>::<owner_id>"`; a wrong parse means the /api/activity/stream
 * fan-out wakes the wrong (or no) subscriber. Pure — the LISTEN/fan-out rest of
 * the module is PG-IO and not exercised here (importing it opens no connection;
 * the bus is lazy-start).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-activity-bus.test.ts
 */
import { describe, expect, it } from 'vitest';
import { ownerFromPayload } from './agent-activity-bus';

describe('ownerFromPayload', () => {
  it('returns "" for an undefined/empty payload', () => {
    expect(ownerFromPayload(undefined)).toBe('');
    expect(ownerFromPayload('')).toBe('');
  });

  it('extracts the owner_id after the "::" delimiter', () => {
    expect(ownerFromPayload('ws-default::su-abc')).toBe('su-abc');
  });

  it('returns "" when there is no delimiter', () => {
    expect(ownerFromPayload('no-delimiter-here')).toBe('');
  });

  it('keeps everything after the FIRST delimiter (owner ids may contain "::")', () => {
    expect(ownerFromPayload('ws::su::weird::id')).toBe('su::weird::id');
  });

  it('handles an empty workspace or empty owner side', () => {
    expect(ownerFromPayload('::su-only')).toBe('su-only');
    expect(ownerFromPayload('ws-only::')).toBe('');
  });
});
