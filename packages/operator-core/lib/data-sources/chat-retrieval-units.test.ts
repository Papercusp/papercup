import { describe, expect, it } from 'vitest';
import { corpusRouteFor, renderChatUnit, splitIntoWindows } from './chat-retrieval-units';

const at = (iso: string) => ({ postedAt: new Date(iso), id: iso });

describe('splitIntoWindows', () => {
  it('starts a new window when the gap exceeds the threshold', () => {
    const windows = splitIntoWindows([
      at('2026-09-30T10:00:00Z'), at('2026-09-30T10:30:00Z'), at('2026-09-30T11:00:01Z'),
    ], 30 * 60_000);
    expect(windows.map((w) => w.length)).toEqual([2, 1]);
  });

  it('never lets a window cross a UTC day boundary', () => {
    const windows = splitIntoWindows([at('2026-09-30T23:55:00Z'), at('2026-10-01T00:05:00Z')], 30 * 60_000);
    expect(windows.map((w) => w.length)).toEqual([1, 1]);
  });

  it('returns no windows for no messages', () => {
    expect(splitIntoWindows([], 60_000)).toEqual([]);
  });
});

describe('renderChatUnit', () => {
  it('prefers the author label, then the author ref', () => {
    expect(renderChatUnit([
      { providerMessageId: '1', authorRef: 'U1', authorLabel: 'alice', body: 'hi', postedAt: new Date() },
      { providerMessageId: '2', authorRef: 'U2', authorLabel: null, body: 'yo', postedAt: new Date() },
      { providerMessageId: '3', authorRef: null, authorLabel: null, body: '?', postedAt: new Date() },
    ])).toBe('alice: hi\nU2: yo\nunknown: ?');
  });
});

describe('corpusRouteFor', () => {
  const base = {
    kind: 'slack',
    scope: 'organization',
    datatype_mappings: { message: 'chat-message' },
    destination_policy: { 'chat-message': ['document', 'event'] },
    permission_mapping: { mode: 'source-acl' },
  };

  it('writes an organization source routed to documents with a source ACL', () => {
    expect(corpusRouteFor(base)).toEqual({ write: true, scope: 'organization', source: 'slack' });
  });

  it('refuses event-only routing and an organization source without a source ACL', () => {
    expect(corpusRouteFor({ ...base, destination_policy: { 'chat-message': ['event'] } }))
      .toEqual({ write: false, reason: 'destination_not_document' });
    expect(corpusRouteFor({ ...base, permission_mapping: { mode: 'owner' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
  });

  it('routes a personal source to its owner vault, keyed by the provider account', () => {
    const personal = {
      ...base, scope: 'personal', permission_mapping: { mode: 'owner' },
      owner_user_id: 'u-1', provider_account_id: 'T1:UALICE',
    };
    expect(corpusRouteFor(personal))
      .toEqual({ write: true, scope: 'personal', source: 'slack', userId: 'u-1', providerAccountId: 'T1:UALICE' });
    expect(corpusRouteFor({ ...personal, permission_mapping: { mode: 'source-acl' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
    expect(corpusRouteFor({ ...personal, owner_user_id: null })).toEqual({ write: false, reason: 'personal_owner_missing' });
    expect(corpusRouteFor({ ...personal, provider_account_id: ' ' })).toEqual({ write: false, reason: 'personal_account_missing' });
  });

  it('routes a pot source to its scope_ref, and refuses a source ACL that a pot row cannot carry', () => {
    const pot = { ...base, scope: 'pot', permission_mapping: { mode: 'owner' }, scope_ref: 'research-pot' };
    expect(corpusRouteFor(pot)).toEqual({ write: true, scope: 'pot', source: 'slack', potSlug: 'research-pot' });
    expect(corpusRouteFor({ ...pot, permission_mapping: { mode: 'source-acl' } }))
      .toEqual({ write: false, reason: 'permission_mapping_mismatch' });
    expect(corpusRouteFor({ ...pot, scope_ref: null })).toEqual({ write: false, reason: 'pot_ref_missing' });
    expect(corpusRouteFor({ ...base, scope: 'team' })).toEqual({ write: false, reason: 'scope_unknown' });
  });

  it('follows a custom datatype mapping for messages', () => {
    expect(corpusRouteFor({
      ...base, datatype_mappings: { message: 'slack-message' }, destination_policy: { 'slack-message': ['document'] },
    })).toEqual({ write: true, scope: 'organization', source: 'slack' });
  });
});
