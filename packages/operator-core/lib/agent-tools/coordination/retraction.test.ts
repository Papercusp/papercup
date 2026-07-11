/**
 * retraction.test.ts — coord:retract v1's PURE core (coord-authority-hardening-
 * 2026-07-11 P-011 / WI-4176, H5c).
 *
 * No mocks: retraction.ts is the import-light half (the P-001/P-008 house
 * split). Pins the marker reader's defensiveness, the raw-window marker
 * collection, the suppression fold (notice survives, target dropped), and the
 * invoker-guard precedence table (sender > leader > queen > owner > refuse —
 * the classifyFleetControlInvoker P-009 shape).
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/retraction.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import {
  RETRACTS_FIELD,
  classifyRetractInvoker,
  collectRetractedIds,
  readRetractionTarget,
  suppressRetracted,
} from './retraction';

function env(p: Partial<CoordEnvelope> = {}): CoordEnvelope {
  return { ts: '2026-07-11T12:00:00.000Z', msg_id: 'm0', from: 'alice', to: ['bob'], kind: 'message', ...p };
}

describe('readRetractionTarget', () => {
  it('reads the retracted msg_id off a notice row', () => {
    expect(readRetractionTarget(env({ [RETRACTS_FIELD]: 'm-target' }))).toBe('m-target');
  });

  it('is defensive: non-notice, blank, non-string, and non-object all read as null', () => {
    expect(readRetractionTarget(env())).toBeNull();
    expect(readRetractionTarget(env({ [RETRACTS_FIELD]: '' }))).toBeNull();
    expect(readRetractionTarget(env({ [RETRACTS_FIELD]: '   ' }))).toBeNull();
    expect(readRetractionTarget(env({ [RETRACTS_FIELD]: 42 }))).toBeNull();
    expect(readRetractionTarget(env({ [RETRACTS_FIELD]: { nested: true } }))).toBeNull();
    expect(readRetractionTarget(null)).toBeNull();
    expect(readRetractionTarget(undefined)).toBeNull();
    expect(readRetractionTarget('m-target')).toBeNull();
  });
});

describe('collectRetractedIds', () => {
  it('collects every retracted id across the window, ignoring non-notices', () => {
    const ids = collectRetractedIds([
      env({ msg_id: 'a' }),
      env({ msg_id: 'n1', [RETRACTS_FIELD]: 'a' }),
      env({ msg_id: 'b' }),
      env({ msg_id: 'n2', [RETRACTS_FIELD]: 'zz' }),
      null,
      'garbage',
    ]);
    expect([...ids].sort()).toEqual(['a', 'zz']);
  });

  it('returns an empty set for an empty / notice-free window', () => {
    expect(collectRetractedIds([]).size).toBe(0);
    expect(collectRetractedIds([env(), env({ msg_id: 'x' })]).size).toBe(0);
  });
});

describe('suppressRetracted', () => {
  it('drops the retracted target; the notice and everything else survive', () => {
    const original = env({ msg_id: 'a', summary: 'WRONG directive' });
    const notice = env({ msg_id: 'n1', [RETRACTS_FIELD]: 'a', from: 'system:coord-retract' });
    const bystander = env({ msg_id: 'b' });
    const out = suppressRetracted([original, notice, bystander]);
    expect(out.map((e) => e.msg_id)).toEqual(['n1', 'b']);
  });

  it('accepts an explicitly wider marker set (raw window) than the entries themselves', () => {
    // The notice was dropped by an upstream filter — its marker, collected
    // from the RAW window, must still suppress the target.
    const original = env({ msg_id: 'a' });
    const out = suppressRetracted([original], new Set(['a']));
    expect(out).toEqual([]);
  });

  it('no markers ⇒ a copy, not the same array', () => {
    const entries = [env({ msg_id: 'a' }), env({ msg_id: 'b' })];
    const out = suppressRetracted(entries);
    expect(out).toEqual(entries);
    expect(out).not.toBe(entries);
  });
});

describe('classifyRetractInvoker', () => {
  const base = { senderFleetLeaders: [] as string[], paneKind: null };

  it('the original sender qualifies as sender', () => {
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'x', senderOwnerId: 'x' })).toBe('sender');
  });

  it("the SENDER's fleet leader qualifies as leader", () => {
    expect(
      classifyRetractInvoker({ callerOwnerId: 'lead', senderOwnerId: 'x', senderFleetLeaders: ['lead'], paneKind: null }),
    ).toBe('leader');
  });

  it('a mug/kettle pane qualifies as queen; an su pane as owner (the owner-proxy rule)', () => {
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'q', senderOwnerId: 'x', paneKind: 'mug' })).toBe('queen');
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'q', senderOwnerId: 'x', paneKind: 'kettle' })).toBe('queen');
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 's', senderOwnerId: 'x', paneKind: 'su' })).toBe('owner');
  });

  it('everyone else is refused (null) — a cup/papercup/planner pane, an unrelated peer', () => {
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'p', senderOwnerId: 'x', paneKind: 'cup' })).toBeNull();
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'p', senderOwnerId: 'x', paneKind: 'papercup' })).toBeNull();
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'p', senderOwnerId: 'x', paneKind: 'planner' })).toBeNull();
    expect(classifyRetractInvoker({ ...base, callerOwnerId: 'p', senderOwnerId: 'x', paneKind: null })).toBeNull();
  });

  it('precedence: identity match wins over leader; leader wins over pane authority', () => {
    expect(
      classifyRetractInvoker({ callerOwnerId: 'x', senderOwnerId: 'x', senderFleetLeaders: ['x'], paneKind: 'mug' }),
    ).toBe('sender');
    expect(
      classifyRetractInvoker({ callerOwnerId: 'l', senderOwnerId: 'x', senderFleetLeaders: ['l'], paneKind: 'mug' }),
    ).toBe('leader');
  });

  it('a blank caller id never identity-matches a blank sender (defensive)', () => {
    expect(classifyRetractInvoker({ ...base, callerOwnerId: '', senderOwnerId: '' })).toBeNull();
  });
});
