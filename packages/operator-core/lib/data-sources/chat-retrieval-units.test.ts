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

  it('writes for an organization source routed to documents with a source ACL', () => {
    expect(corpusRouteFor(base)).toEqual({ write: true, source: 'slack' });
  });

  it('refuses personal scope, event-only routing, and owner permission mapping', () => {
    expect(corpusRouteFor({ ...base, scope: 'personal' })).toEqual({ write: false, reason: 'scope_not_organization' });
    expect(corpusRouteFor({ ...base, destination_policy: { 'chat-message': ['event'] } }))
      .toEqual({ write: false, reason: 'destination_not_document' });
    expect(corpusRouteFor({ ...base, permission_mapping: { mode: 'owner' } }))
      .toEqual({ write: false, reason: 'permission_mapping_not_source_acl' });
  });

  it('follows a custom datatype mapping for messages', () => {
    expect(corpusRouteFor({
      ...base, datatype_mappings: { message: 'slack-message' }, destination_policy: { 'slack-message': ['document'] },
    })).toEqual({ write: true, source: 'slack' });
  });
});
