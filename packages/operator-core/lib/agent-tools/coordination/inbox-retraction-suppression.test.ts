/**
 * inbox-retraction-suppression.test.ts — readInbox is the chokepoint every
 * owner-scoped read rides (coord:inbox, the [coord+N] injection, orient's
 * inbox fold), so coord:retract suppression is pinned HERE (coord-authority-
 * hardening-2026-07-11 P-011 / WI-4176).
 *
 * The messages-get-by-id.test.ts recipe: only ./log is mocked (fast path OFF ⇒
 * the authoritative readLines + filterInbox path runs for real), so the test
 * exercises real filterInbox + real suppressRetracted composed exactly as
 * production does. (The PG fast path ends in the SAME suppress-wrapped return
 * expression; the pushdown itself is covered by
 * messages-inbox.integration.test.ts.)
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/inbox-retraction-suppression.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLinesMock } = vi.hoisted(() => ({ readLinesMock: vi.fn(async () => [] as unknown[]) }));

vi.mock('./log', () => ({
  coordLog: { readLines: readLinesMock },
  coordSql: vi.fn(),
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => false,
}));

import type { CoordEnvelope } from '@papercusp/coordination/core';
import { readInbox } from './messages';
import { RETRACTS_FIELD } from './retraction';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-07-11T12:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLinesMock.mockResolvedValue([]);
});

describe('readInbox retraction suppression (WI-4176)', () => {
  it('a retracted message disappears from the inbox; the notice row survives', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'm-bad', ts: '2026-07-11T12:00:00.000Z', summary: 'WRONG directive' }),
      env({ msg_id: 'm-ok', ts: '2026-07-11T12:00:01.000Z' }),
      env({
        msg_id: 'n-1',
        ts: '2026-07-11T12:00:02.000Z',
        from: 'system:coord-retract',
        summary: '⛔ RETRACTED: "WRONG directive" (m-bad)',
        related_msg_id: 'm-bad',
        [RETRACTS_FIELD]: 'm-bad',
      }),
    ]);
    const inbox = await readInbox('bob');
    expect(inbox.map((e) => e.msg_id)).toEqual(['m-ok', 'n-1']);
  });

  it('markers are collected from the RAW pre-filter window: a kinds filter that drops the notice still suppresses its target', async () => {
    readLinesMock.mockResolvedValue([
      env({ msg_id: 'm-bad', kind: 'notify', ts: '2026-07-11T12:00:00.000Z' }),
      env({ msg_id: 'm-ok', kind: 'notify', ts: '2026-07-11T12:00:01.000Z' }),
      // The notice is kind 'message' — a kinds:['notify'] read filters it out,
      // but its marker (collected pre-filter) must still suppress m-bad.
      env({ msg_id: 'n-1', kind: 'message', ts: '2026-07-11T12:00:02.000Z', [RETRACTS_FIELD]: 'm-bad' }),
    ]);
    const inbox = await readInbox('bob', { kinds: ['notify'] });
    expect(inbox.map((e) => e.msg_id)).toEqual(['m-ok']);
  });

  it('no notices ⇒ the inbox is untouched', async () => {
    readLinesMock.mockResolvedValue([env({ msg_id: 'a' }), env({ msg_id: 'b', ts: '2026-07-11T12:00:01.000Z' })]);
    const inbox = await readInbox('bob');
    expect(inbox.map((e) => e.msg_id)).toEqual(['a', 'b']);
  });
});
