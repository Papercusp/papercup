/**
 * blocked-on-status.test.ts — coord-derived-fields-2026-08-31 P-005.
 *
 * Pins the three pure seams (collect → verdict → render) plus the fail-soft
 * contract on the DB-touching annotator: losing the marker must never cost the
 * caller their inbox, and no verdict is ever fabricated from an unknown ledger.
 */
import { describe, it, expect } from 'vitest';
import {
  BLOCKED_ON_STATUS_FIELD,
  collectBlockedOnRefs,
  blockedOnVerdict,
  annotateBlockedOnStatus,
  renderBlockedOnStatusSuffix,
  type BlockedOnStatusStamp,
} from './blocked-on-status';

describe('collectBlockedOnRefs (pure)', () => {
  it('collects work-item and event refs from sections', () => {
    const entry = {
      sections: [
        { text: 'a', blockedOn: { kind: 'work-item', ref: 'WI-123' } },
        { text: 'b', blockedOn: { kind: 'event', ref: 'fleet:x:gate-open' } },
      ],
    };
    expect(collectBlockedOnRefs(entry)).toEqual([
      { kind: 'work-item', ref: 'WI-123' },
      { kind: 'event', ref: 'fleet:x:gate-open' },
    ]);
  });

  it('skips non-diffable kinds — process/agent/owner/other get NO verdict, so they are never collected', () => {
    const entry = {
      sections: [
        { blockedOn: { kind: 'process', ref: 'pid-999' } },
        { blockedOn: { kind: 'agent', ref: 'su-abc' } },
        { blockedOn: { kind: 'owner', ref: 'a decision' } },
        { blockedOn: { kind: 'other', ref: 'weather' } },
      ],
    };
    expect(collectBlockedOnRefs(entry)).toEqual([]);
  });

  it('skips malformed shapes without throwing: no sections, non-array sections, null section, missing/blank ref', () => {
    expect(collectBlockedOnRefs({})).toEqual([]);
    expect(collectBlockedOnRefs({ sections: 'nope' })).toEqual([]);
    expect(collectBlockedOnRefs({ sections: [null, 42, { blockedOn: null }] })).toEqual([]);
    expect(collectBlockedOnRefs({ sections: [{ blockedOn: { kind: 'work-item' } }] })).toEqual([]);
    expect(collectBlockedOnRefs({ sections: [{ blockedOn: { kind: 'work-item', ref: '   ' } }] })).toEqual([]);
  });

  it('trims whitespace from refs', () => {
    const entry = { sections: [{ blockedOn: { kind: 'work-item', ref: '  WI-9  ' } }] };
    expect(collectBlockedOnRefs(entry)).toEqual([{ kind: 'work-item', ref: 'WI-9' }]);
  });
});

describe('blockedOnVerdict (pure)', () => {
  const sentAtMs = Date.parse('2026-08-31T12:00:00Z');

  it('open blocker → pending, with live state echoed and no clearedAt', () => {
    const v = blockedOnVerdict({ kind: 'work-item', ref: 'WI-1', sentAtMs, clearedAtMs: null, state: 'wip' });
    expect(v).toEqual({ kind: 'work-item', ref: 'WI-1', verdict: 'pending', state: 'wip' });
    expect(v.clearedAt).toBeUndefined();
  });

  it('cleared AFTER send → cleared-since-send (the wait is over)', () => {
    const clearedAtMs = sentAtMs + 60_000;
    const v = blockedOnVerdict({ kind: 'work-item', ref: 'WI-1', sentAtMs, clearedAtMs, state: 'done' });
    expect(v.verdict).toBe('cleared-since-send');
    expect(v.clearedAt).toBe(new Date(clearedAtMs).toISOString());
  });

  it('cleared BEFORE send → already-cleared-at-send (the sender cited a stale blocker)', () => {
    const clearedAtMs = sentAtMs - 60_000;
    const v = blockedOnVerdict({ kind: 'event', ref: 'gate:x', sentAtMs, clearedAtMs, state: 'fired' });
    expect(v.verdict).toBe('already-cleared-at-send');
  });

  it('cleared exactly AT send → already-cleared-at-send (strictly-after is the since-send bar)', () => {
    const v = blockedOnVerdict({ kind: 'work-item', ref: 'WI-1', sentAtMs, clearedAtMs: sentAtMs });
    expect(v.verdict).toBe('already-cleared-at-send');
  });

  it('omits state when not provided', () => {
    const v = blockedOnVerdict({ kind: 'work-item', ref: 'WI-1', sentAtMs, clearedAtMs: null });
    expect('state' in v).toBe(false);
  });
});

describe('annotateBlockedOnStatus (fail-soft)', () => {
  it('returns entries untouched when none carry a diffable blockedOn (no DB round-trip needed)', async () => {
    const entries = [{ msg_id: 'm1', ts: '2026-08-31T12:00:00Z', sections: [{ text: 'hi' }] }];
    const out = await annotateBlockedOnStatus(entries, { workspaceId: 'ws' });
    expect(out).toBe(entries); // same array — the no-work path short-circuits
  });

  it('returns entries unannotated (never throws) when the database is unreachable', async () => {
    const entries: Record<string, unknown>[] = [
      {
        msg_id: 'm1',
        ts: '2026-08-31T12:00:00Z',
        sections: [{ blockedOn: { kind: 'work-item', ref: 'WI-1' } }],
      },
    ];
    const out = await annotateBlockedOnStatus(entries, { workspaceId: 'unit-test-no-db' });
    expect(out).toHaveLength(1);
    expect(out[0][BLOCKED_ON_STATUS_FIELD]).toBeUndefined();
  });
});

describe('renderBlockedOnStatusSuffix (pure)', () => {
  const stamp = (over: Partial<BlockedOnStatusStamp>): BlockedOnStatusStamp => ({
    kind: 'work-item',
    ref: 'WI-1',
    verdict: 'pending',
    ...over,
  });

  it('renders nothing for non-arrays and empty arrays', () => {
    expect(renderBlockedOnStatusSuffix(undefined)).toBe('');
    expect(renderBlockedOnStatusSuffix('x')).toBe('');
    expect(renderBlockedOnStatusSuffix([])).toBe('');
  });

  it('pending is deliberately NOT rendered — the news is when the wait ends', () => {
    expect(renderBlockedOnStatusSuffix([stamp({ verdict: 'pending', state: 'wip' })])).toBe('');
  });

  it('renders cleared-since-send with the live state', () => {
    const s = renderBlockedOnStatusSuffix([stamp({ verdict: 'cleared-since-send', state: 'done' })]);
    expect(s).toBe(' ⛓ blocker: WI-1 cleared since send (now done)');
  });

  it('renders already-cleared-at-send, and suppresses the (now …) echo for event "fired" state', () => {
    const s = renderBlockedOnStatusSuffix([
      stamp({ kind: 'event', ref: 'gate:x', verdict: 'already-cleared-at-send', state: 'fired' }),
    ]);
    expect(s).toBe(' ⛓ blocker: gate:x had ALREADY cleared at send');
  });

  it('caps at 3 rendered verdicts and joins with "; "', () => {
    const stamps = ['WI-1', 'WI-2', 'WI-3', 'WI-4'].map((ref) =>
      stamp({ ref, verdict: 'cleared-since-send' as const }),
    );
    const s = renderBlockedOnStatusSuffix(stamps);
    expect(s).toContain('WI-1');
    expect(s).toContain('WI-3');
    expect(s).not.toContain('WI-4');
    expect(s.split(';')).toHaveLength(3);
  });

  it('ignores malformed members without throwing', () => {
    expect(renderBlockedOnStatusSuffix([null, 42, { verdict: 'bogus' }])).toBe('');
  });
});
