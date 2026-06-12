/**
 * feedback-rerank — the memory_feedback consumer (EI-366 / consume-edges
 * P-031). Pins the two consumers: tombstone dedup (deleted ids — incl. the
 * hybrid projection's link_id ghosts) and deleted-content demotion/drop.
 */
import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';
import {
  applyFeedbackRerank,
  isFeedbackSuppressed,
  loadFeedbackSignals,
  normalizeMemoryText,
  DELETED_TEXT_PENALTY,
  type FeedbackSignals,
} from './feedback-rerank';

const entry = (id: string, text: string, score?: number, metadata?: Record<string, unknown>): MemoryEntry => ({
  id,
  text,
  scope: 's',
  ...(score !== undefined ? { score } : {}),
  ...(metadata !== undefined ? { metadata } : {}),
});

const signals = (deletedIds: string[] = [], deletedTexts: string[] = []): FeedbackSignals => ({
  deletedIds: new Set(deletedIds),
  deletedTexts: new Set(deletedTexts.map(normalizeMemoryText)),
});

describe('applyFeedbackRerank (pull path)', () => {
  it('no signals → identity', () => {
    const xs = [entry('a', 'alpha', 0.9)];
    expect(applyFeedbackRerank(xs, signals())).toBe(xs);
  });

  it('drops tombstoned ids', () => {
    const xs = [entry('a', 'alpha', 0.9), entry('b', 'beta', 0.8)];
    expect(applyFeedbackRerank(xs, signals(['a'])).map((e) => e.id)).toEqual(['b']);
  });

  it('drops lexical-projection ghosts via metadata.link_id', () => {
    // The hybrid backend stamps link_id = canonical id on the projection;
    // a delete removes only the canonical row, so the ghost matches here.
    const ghost = entry('lex-1', 'alpha', 0.7, { link_id: 'canon-1' });
    expect(applyFeedbackRerank([ghost], signals(['canon-1']))).toEqual([]);
  });

  it('demotes a re-extraction of deleted content and re-ranks', () => {
    const junk = entry('new-id', 'Ticks   With', 0.9); // re-stored junk, new id
    const real = entry('b', 'a real fact', 0.6);
    const out = applyFeedbackRerank([junk, real], signals([], ['ticks with']));
    expect(out.map((e) => e.id)).toEqual(['b', 'new-id']);
    expect(out[1].score).toBeCloseTo(0.9 * DELETED_TEXT_PENALTY);
  });
});

describe('isFeedbackSuppressed (push path)', () => {
  it('suppresses tombstones, link_id ghosts and deleted content; passes the rest', () => {
    const s = signals(['dead'], ['deleted fact text']);
    expect(isFeedbackSuppressed(entry('dead', 'x'), s)).toBe(true);
    expect(isFeedbackSuppressed(entry('y', 'x', 0.5, { link_id: 'dead' }), s)).toBe(true);
    expect(isFeedbackSuppressed(entry('z', '  Deleted   FACT text '), s)).toBe(true);
    expect(isFeedbackSuppressed(entry('ok', 'unrelated'), s)).toBe(false);
  });
});

describe('loadFeedbackSignals', () => {
  it('maps delete rows to id + normalized-text sets', async () => {
    const sql = ((_s: TemplateStringsArray, ..._v: unknown[]) =>
      Promise.resolve([
        { mem_id: 'm1', prior_text: '  Ticks   With ' },
        { mem_id: 'm2', prior_text: null },
        { mem_id: null, prior_text: 'orphan text' },
      ])) as unknown as Sql;
    const out = await loadFeedbackSignals(sql);
    expect([...out.deletedIds].sort()).toEqual(['m1', 'm2']);
    expect(out.deletedTexts.has('ticks with')).toBe(true);
    expect(out.deletedTexts.has('orphan text')).toBe(true);
  });
});
