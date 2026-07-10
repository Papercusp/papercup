/**
 * messages-get-by-id.test.ts — WI-3832 regression: getMessageById must find a
 * message by msg_id WITHOUT going through the handoffs/escalations-only
 * `coordLog.getEvent('messages', …)` call (a real TS2345 compile error, and a
 * genuine runtime gap on the in-memory/fs test backends — see the fix's
 * comment in messages.ts for the full story). Both the PG-fast-path branch and
 * the readLines fallback are covered directly (no DB required — coordSql/
 * coordHasPgFastPath/coordLog are mocked).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
let hasPgFastPath = false;
const readLinesMock = vi.fn(async () => [] as unknown[]);

vi.mock('./log', () => ({
  coordLog: { readLines: (...args: unknown[]) => readLinesMock(...args) },
  coordSql: () => sqlMock,
  coordWorkspaceId: () => 'default',
  coordHasPgFastPath: () => hasPgFastPath,
}));

import { getMessageById } from './messages';

beforeEach(() => {
  vi.clearAllMocks();
  hasPgFastPath = false;
});

describe('getMessageById (WI-3832)', () => {
  it('returns null for an empty msgId without touching the store', async () => {
    expect(await getMessageById('')).toBeNull();
    expect(readLinesMock).not.toHaveBeenCalled();
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('non-PG backend (test/dev): finds the message by scanning readLines("messages")', async () => {
    readLinesMock.mockResolvedValueOnce([
      { msg_id: 'other', from: 'a', to: ['b'], kind: 'note', ts: '2026-07-10T00:00:00Z' },
      { msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: '2026-07-10T00:00:01Z', summary: 'hi' },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(found?.summary).toBe('hi');
    expect(readLinesMock).toHaveBeenCalledWith('messages');
  });

  it('non-PG backend: returns null when no message matches', async () => {
    readLinesMock.mockResolvedValueOnce([{ msg_id: 'other', from: 'a', to: ['b'], kind: 'note', ts: 't' }]);
    expect(await getMessageById('missing')).toBeNull();
  });

  it('PG fast path: queries coord_event_log directly and does not fall back to readLines', async () => {
    hasPgFastPath = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: { msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't', summary: 'hi' } },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: a JSON-string body is parsed', async () => {
    hasPgFastPath = true;
    sqlMock.mockImplementationOnce(async () => [
      { body: JSON.stringify({ msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't' }) },
    ]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
  });

  it('PG fast path: no rows -> null, no fallback scan', async () => {
    hasPgFastPath = true;
    sqlMock.mockImplementationOnce(async () => []);
    expect(await getMessageById('nope')).toBeNull();
    expect(readLinesMock).not.toHaveBeenCalled();
  });

  it('PG fast path: a query error falls through to the readLines fallback', async () => {
    hasPgFastPath = true;
    sqlMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    readLinesMock.mockResolvedValueOnce([{ msg_id: 'orig', from: 'a', to: ['b'], kind: 'note', ts: 't' }]);
    const found = await getMessageById('orig');
    expect(found?.msg_id).toBe('orig');
    expect(readLinesMock).toHaveBeenCalledWith('messages');
  });
});
