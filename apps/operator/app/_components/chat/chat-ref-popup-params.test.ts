/**
 * The `wpop`/`wppop` grammar (WI-6601). Pure string round-tripping — the point
 * is that the THREE writers and the ONE reader cannot disagree, so the
 * round-trip property matters more than any single case.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_PLAN_POPUP_PARAM,
  CHAT_WORK_ITEM_POPUP_PARAM,
  decodeScopedRef,
  encodeScopedRef,
} from './chat-ref-popup-params';

describe('chat ref popup params', () => {
  it('keeps the two param keys distinct (they can be open independently)', () => {
    expect(CHAT_WORK_ITEM_POPUP_PARAM).toBe('wpop');
    expect(CHAT_PLAN_POPUP_PARAM).toBe('wppop');
    expect(CHAT_WORK_ITEM_POPUP_PARAM).not.toBe(CHAT_PLAN_POPUP_PARAM);
  });

  it('round-trips a harness-qualified ref', () => {
    const encoded = encodeScopedRef('papercusp', 'WI-6594');
    expect(encoded).toBe('papercusp::WI-6594');
    expect(decodeScopedRef(encoded)).toEqual({ harness: 'papercusp', id: 'WI-6594' });
  });

  it('encodes a null/undefined harness as a BARE id, not an empty scope', () => {
    // `"::WI-1"` would be a second spelling of the same thing — one spelling
    // means a writer and the reader cannot drift.
    expect(encodeScopedRef(null, 'WI-1')).toBe('WI-1');
    expect(encodeScopedRef(undefined, 'WI-1')).toBe('WI-1');
    expect(encodeScopedRef('', 'WI-1')).toBe('WI-1');
  });

  it('decodes a bare value to a null harness (back-compat with pre-WI-6601 links)', () => {
    expect(decodeScopedRef('my-plan-2026-07-28')).toEqual({
      harness: null,
      id: 'my-plan-2026-07-28',
    });
  });

  it('decodes absent/blank as closed', () => {
    expect(decodeScopedRef(null)).toEqual({ harness: null, id: null });
    expect(decodeScopedRef(undefined)).toEqual({ harness: null, id: null });
    expect(decodeScopedRef('')).toEqual({ harness: null, id: null });
  });

  it('tolerates a degenerate value rather than throwing', () => {
    expect(decodeScopedRef('::')).toEqual({ harness: null, id: null });
    expect(decodeScopedRef('papercusp::')).toEqual({ harness: 'papercusp', id: null });
    expect(decodeScopedRef('::WI-1')).toEqual({ harness: null, id: 'WI-1' });
  });

  it('splits on the FIRST separator, so an id containing "::" survives', () => {
    expect(decodeScopedRef('h::a::b')).toEqual({ harness: 'h', id: 'a::b' });
  });

  it('round-trips every id shape the pills emit', () => {
    for (const id of ['WI-6594', 'EI-18882459651967528', 'F-100', 'plan-slug-2026-07-28']) {
      expect(decodeScopedRef(encodeScopedRef('papercusp', id))).toEqual({
        harness: 'papercusp',
        id,
      });
    }
  });
});
