// operator-hindsight — unit contract for the TWO-delivery push
// (operator-chat-sidebar-revival-2026-07-13 P-008), plus the bounded
// notify_kind-scoped read (EI-19323414462286091 / EI-19325897270823423 /
// EI-19314819320465915).
//
// Leg 1 (coord notify → voice drain) predates this test. Leg 2 is the fix this
// pins: hindsight must ALSO land as a `system` turn in the SHARED operator
// conversation, because with the native dock testing-gated dark (D-004) and
// voice off, the coord notify alone is drained by NOBODY — a settled deep-dive
// answer or handoff landing was invisible to the typed-turn sidebar user.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';

const h = vi.hoisted(() => ({
  // Loose arg tuples (…unknown[]) — vi.fn(async () => {}) infers a [] tuple, so
  // .mock.calls[0][2] is a TS2493 error under the gate's typecheck (81c1a report).
  appendLine: vi.fn(async (..._args: unknown[]) => {}),
  getOrCreateActiveConversation: vi.fn(async () => ({ id: 'conv-1' })),
  appendTurn: vi.fn(async (..._args: unknown[]) => ({ id: 't-1', seq: 1 })),
  notifySyncInvalidate: vi.fn(async (..._args: unknown[]) => {}),
  readInbox: vi.fn(async () => [] as CoordEnvelope[]),
  readAckedMsgIds: vi.fn(async () => new Set<string>()),
  appendAck: vi.fn(async () => {}),
  // coordHasPgFastPath defaults true so the bounded SQL path is exercised by
  // default; individual tests flip it to prove the readInbox fallback.
  coordHasPgFastPath: vi.fn(() => true),
  coordWorkspaceId: vi.fn(() => 'ws-1'),
  sqlTexts: [] as string[],
  // A fake postgres.js tagged-template client: distinguishes the CANDIDATE
  // query from the RETRACT-lookup query by which string literal segment each
  // call's template strings contain, so a test can script each independently
  // without depending on exact query text.
  sqlRows: { candidates: [] as { body: unknown }[], retracts: [] as { body: unknown }[] },
}));

function fakeSql(strings: TemplateStringsArray): Promise<{ body: unknown }[]> {
  const text = strings.join('');
  h.sqlTexts.push(text);
  if (text.includes("body ->> 'retracts'") || text.includes('body ? \'retracts\'')) {
    return Promise.resolve(h.sqlRows.retracts);
  }
  return Promise.resolve(h.sqlRows.candidates);
}

vi.mock('./agent-tools/coordination/log', () => ({
  coordLog: { appendLine: h.appendLine },
  coordSql: () => fakeSql,
  coordWorkspaceId: h.coordWorkspaceId,
  coordHasPgFastPath: h.coordHasPgFastPath,
}));
vi.mock('./agent-tools/coordination/messages', () => ({
  readInbox: h.readInbox,
  readAckedMsgIds: h.readAckedMsgIds,
  appendAck: h.appendAck,
}));
vi.mock('./operator-conversations', () => ({
  getOrCreateActiveConversation: h.getOrCreateActiveConversation,
  appendTurn: h.appendTurn,
}));
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: h.notifySyncInvalidate,
}));

import {
  notifyOperatorHindsight,
  drainOperatorHindsight,
  peekOperatorHindsight,
  HINDSIGHT_NOTIFY_KIND,
} from './operator-hindsight';

function hindsightEnvelope(msgId: string, ts: string, summary: string): CoordEnvelope {
  return {
    ts,
    msg_id: msgId,
    from: 'substrate',
    to: ['operator'],
    kind: 'notify',
    summary,
    notify_kind: HINDSIGHT_NOTIFY_KIND,
    hindsight_kind: 'delegate-complete',
  } as CoordEnvelope;
}

describe('notifyOperatorHindsight — two deliveries (P-008)', () => {
  beforeEach(() => {
    h.appendLine.mockClear();
    h.getOrCreateActiveConversation.mockClear();
    h.appendTurn.mockClear();
    h.notifySyncInvalidate.mockClear();
    h.appendTurn.mockImplementation(async () => ({ id: 't-1', seq: 1 }));
  });

  it('pushes the coord notify AND appends a system turn to the shared conversation', async () => {
    await notifyOperatorHindsight('Deep dive WI-123 landed: the answer.', 'deep-answer');

    // Leg 1 — coord notify (voice drain).
    expect(h.appendLine).toHaveBeenCalledTimes(1);
    const env = h.appendLine.mock.calls[0]![2] as { kind: string; summary: string };
    expect(env.kind).toBe('notify');
    expect(env.summary).toBe('Deep dive WI-123 landed: the answer.');

    // Leg 2 — shared-thread system turn, prefixed for the transcript.
    expect(h.appendTurn).toHaveBeenCalledTimes(1);
    expect(h.appendTurn.mock.calls[0]![0]).toMatchObject({
      conversationId: 'conv-1',
      role: 'system',
      source: 'system',
      text: '[While you were away] Deep dive WI-123 landed: the answer.',
    });
    // Live sidebars refresh via the same sync query they already subscribe to.
    expect(h.notifySyncInvalidate).toHaveBeenCalledWith('operatorTurns.page', {
      conversationId: 'conv-1',
    });
  });

  it('a thread-append failure never loses the coord notify (fail-soft)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.appendTurn.mockImplementation(async () => {
      throw new Error('pg down');
    });

    await expect(
      notifyOperatorHindsight('Your request "x" landed (WI-9).', 'handoff-landed'),
    ).resolves.toBeUndefined();

    expect(h.appendLine).toHaveBeenCalledTimes(1); // leg 1 still delivered
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('shared-thread append failed'),
      expect.any(String),
    );
    warnSpy.mockRestore();
  });
});

// EI-19323414462286091 / EI-19325897270823423 / EI-19314819320465915 — peek/drain
// must go through the bounded, notify_kind-scoped SQL path (readHindsightNotifyEnvelopes),
// not the unbounded readInbox fast path, and must still honor retraction + ordering.
describe('peekOperatorHindsight / drainOperatorHindsight — bounded notify_kind read', () => {
  beforeEach(() => {
    h.readInbox.mockClear();
    h.readAckedMsgIds.mockClear();
    h.appendAck.mockClear();
    h.coordHasPgFastPath.mockClear();
    h.coordHasPgFastPath.mockReturnValue(true);
    h.sqlTexts.length = 0;
    h.sqlRows.candidates = [];
    h.sqlRows.retracts = [];
    h.readAckedMsgIds.mockResolvedValue(new Set());
    h.appendAck.mockResolvedValue(undefined);
  });

  it('never falls back to the unbounded readInbox when the PG fast path is up', async () => {
    h.sqlRows.candidates = [{ body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'one') }];
    await peekOperatorHindsight();
    expect(h.readInbox).not.toHaveBeenCalled();
  });

  it('uses the native JSONB recipient operator for the GIN-indexed fast path', async () => {
    h.sqlRows.candidates = [{ body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'one') }];

    await peekOperatorHindsight();

    expect(h.sqlTexts[0]).toContain("(body->'to') ?");
    expect(h.sqlTexts[0]).not.toContain('jsonb_exists');
  });

  it('peek counts unacked candidates from the SQL push-down, acked ones excluded', async () => {
    h.sqlRows.candidates = [
      { body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'one') },
      { body: hindsightEnvelope('m2', '2026-08-02T00:00:02Z', 'two') },
    ];
    h.readAckedMsgIds.mockResolvedValue(new Set(['m1']));
    expect((await peekOperatorHindsight()).pending).toBe(1);
  });

  it('drain returns headlines in CHRONOLOGICAL (oldest-first) order even though the SQL query is DESC-ordered', async () => {
    // SQL returns newest-first (id DESC, matching readInbox's own fast-path
    // degrade-by-forgetting-the-oldest convention) — the function must re-sort
    // ascending before returning, same output order readInbox+filterInbox give
    // every other caller.
    h.sqlRows.candidates = [
      { body: hindsightEnvelope('m2', '2026-08-02T00:00:02Z', 'newer, listed first by SQL') },
      { body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'older, listed second by SQL') },
    ];
    const drained = await drainOperatorHindsight();
    expect(drained.map((d) => d.headline)).toEqual([
      'older, listed second by SQL',
      'newer, listed first by SQL',
    ]);
  });

  it('suppresses a candidate a retraction notice (scoped to its msg_id) targets', async () => {
    h.sqlRows.candidates = [
      { body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'retracted') },
      { body: hindsightEnvelope('m2', '2026-08-02T00:00:02Z', 'survives') },
    ];
    h.sqlRows.retracts = [
      {
        body: {
          ts: '2026-08-02T00:00:03Z',
          msg_id: 'retract-1',
          from: 'substrate',
          to: ['operator'],
          kind: 'notify',
          retracts: 'm1',
        },
      },
    ];
    const drained = await drainOperatorHindsight();
    expect(drained.map((d) => d.headline)).toEqual(['survives']);
  });

  it('drain acks each fresh candidate and excludes it from a re-drain', async () => {
    h.sqlRows.candidates = [{ body: hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'once') }];
    const drained = await drainOperatorHindsight();
    expect(drained.map((d) => d.headline)).toEqual(['once']);
    expect(h.appendAck).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'voice-hindsight' }), 'm1', 'substrate');
  });

  it('falls back to the unbounded readInbox when the PG fast path is unavailable', async () => {
    h.coordHasPgFastPath.mockReturnValue(false);
    h.readInbox.mockResolvedValue([hindsightEnvelope('m1', '2026-08-02T00:00:01Z', 'via fallback')]);
    const result = await peekOperatorHindsight();
    expect(h.readInbox).toHaveBeenCalledWith('operator', { kinds: ['notify'] });
    expect(result.pending).toBe(1);
  });
});
