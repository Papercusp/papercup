/**
 * EI-18680302159738037: fleet-scope admission blocks must reach fleet:leader-brief.
 *
 * The pure halves are tested here (the SQL half is exercised by the integration
 * suite): parsing a stamp, and collapsing repeat refusals into distinct problems.
 */
import { describe, expect, it } from 'vitest';
import {
  FLEET_ADMISSION_BLOCK_ROW_CAP,
  dedupeAdmissionBlocks,
  parseAdmissionBlockStamp,
  type FleetAdmissionBlock,
} from './fleet-scope-admission-blocks';

const META = { msgId: 'msg-1', atMs: 1_700_000_000_000 };

const stamp = (over: Record<string, unknown> = {}) => ({
  itemId: 'WI-5891',
  member: 'su-b0971',
  specId: 'gui-chat-controls',
  specRevision: 3,
  code: 'fleet_scope_violation',
  action: 'work_items:claim WI-5891 → su-b0971',
  reason: 'work-item WI-5891 does not match gui-chat-controls (spec rev 3)',
  ...over,
});

const block = (over: Partial<FleetAdmissionBlock> = {}): FleetAdmissionBlock => ({
  itemId: 'WI-5891',
  member: 'su-b0971',
  specId: 'gui-chat-controls',
  specRevision: 3,
  code: 'fleet_scope_violation',
  action: null,
  reason: null,
  msgId: 'msg-1',
  atMs: 1_000,
  occurrences: 1,
  dependencyEscape: null,
  ...over,
});

describe('parseAdmissionBlockStamp', () => {
  it('recovers the leader-actionable core from a well-formed stamp', () => {
    const parsed = parseAdmissionBlockStamp(stamp(), META);
    expect(parsed).toMatchObject({
      itemId: 'WI-5891',
      member: 'su-b0971',
      specId: 'gui-chat-controls',
      specRevision: 3,
      code: 'fleet_scope_violation',
      msgId: 'msg-1',
      atMs: META.atMs,
      occurrences: 1,
    });
  });

  it.each([
    ['no itemId', stamp({ itemId: undefined })],
    ['blank itemId', stamp({ itemId: '   ' })],
    ['no member', stamp({ member: undefined })],
    ['blank member', stamp({ member: '' })],
  ])('returns null when the stamp lacks the actionable pair (%s)', (_label, raw) => {
    // A row naming only one half tells a leader "something, somewhere was refused",
    // which is strictly worse than silence on a dashboard whose whole purpose is
    // naming the thing only they can unblock.
    expect(parseAdmissionBlockStamp(raw, META)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'WI-5891 was refused'],
    ['an array', [{ itemId: 'WI-5891', member: 'su-b0971' }]],
    ['an empty object', {}],
  ])('returns null for a non-stamp payload (%s)', (_label, raw) => {
    expect(parseAdmissionBlockStamp(raw, META)).toBeNull();
  });

  it('returns null when the timestamp is unusable', () => {
    expect(parseAdmissionBlockStamp(stamp(), { msgId: 'm', atMs: Number.NaN })).toBeNull();
    expect(parseAdmissionBlockStamp(stamp(), { msgId: 'm', atMs: 0 })).toBeNull();
  });

  it('keeps a missing specRevision as null rather than coercing it to 0', () => {
    // 0 is a REAL revision here, so a coerced default would send a leader to
    // re-widen a spec at a revision that never refused anything.
    const parsed = parseAdmissionBlockStamp(stamp({ specRevision: undefined }), META);
    expect(parsed?.specRevision).toBeNull();
    const zero = parseAdmissionBlockStamp(stamp({ specRevision: 0 }), META);
    expect(zero?.specRevision).toBe(0);
  });

  it('clips a pathological reason instead of letting it into the brief whole', () => {
    const parsed = parseAdmissionBlockStamp(stamp({ reason: 'x'.repeat(5_000) }), META);
    expect(parsed?.reason?.length).toBeLessThanOrEqual(240);
  });

  it('recovers a typed three-route dependency escape from the refusal stamp', () => {
    const dependencyEscape = {
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItems: [{ id: 'WI-held', kind: 'change', harness: 'papercusp' }],
      blockedHeldItemIds: ['WI-held'],
      member: 'su-b0971',
      ownershipPreserved: true,
      routes: [
        { kind: 'spec_widen', calls: [] },
        { kind: 'outside_lane_placement', calls: [] },
        { kind: 'leader_claim', calls: [] },
      ],
    };
    expect(parseAdmissionBlockStamp(stamp({ dependencyEscape }), META)?.dependencyEscape).toMatchObject({
      kind: 'dependency_escape',
      dependency: { id: 'WI-blocker', kind: 'issue' },
      blockedHeldItemIds: ['WI-held'],
      ownershipPreserved: true,
    });
  });

  it('drops a malformed dependency escape without dropping the admission block', () => {
    const parsed = parseAdmissionBlockStamp(stamp({
      dependencyEscape: { kind: 'dependency_escape', blockedHeldItemIds: [] },
    }), META);
    expect(parsed).not.toBeNull();
    expect(parsed?.dependencyEscape).toBeNull();
  });
});

describe('dedupeAdmissionBlocks', () => {
  it('collapses repeat refusals of the same pair and counts them', () => {
    const rows = dedupeAdmissionBlocks([
      block({ atMs: 3_000, msgId: 'c' }),
      block({ atMs: 2_000, msgId: 'b' }),
      block({ atMs: 1_000, msgId: 'a' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
  });

  it('keeps the NEWEST refusal detail for a repeated pair', () => {
    // The spec revision on the latest refusal is the one the leader is about to
    // edit; an older one sends them to re-widen a spec that has already moved on.
    const rows = dedupeAdmissionBlocks([
      block({ atMs: 1_000, specRevision: 3, msgId: 'old' }),
      block({ atMs: 9_000, specRevision: 6, msgId: 'new' }),
    ]);
    expect(rows[0]).toMatchObject({ specRevision: 6, msgId: 'new', occurrences: 2 });
  });

  it('treats a different item or a different member as a distinct problem', () => {
    const rows = dedupeAdmissionBlocks([
      block({ itemId: 'WI-1' }),
      block({ itemId: 'WI-2' }),
      block({ itemId: 'WI-1', member: 'su-other' }),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.occurrences === 1)).toBe(true);
  });

  it('orders newest-first and caps the row list', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      block({ itemId: `WI-${i}`, atMs: 1_000 + i }),
    );
    const rows = dedupeAdmissionBlocks(many);
    expect(rows).toHaveLength(FLEET_ADMISSION_BLOCK_ROW_CAP);
    expect(rows[0]?.itemId).toBe('WI-39');
    expect(rows.map((r) => r.atMs)).toEqual([...rows.map((r) => r.atMs)].sort((a, b) => b - a));
  });

  it('counts every repeat even when the cap drops the row', () => {
    // A member stuck in a refusal LOOP is the more urgent read, so the count must
    // not depend on whether that pair survived the cap.
    const rows = dedupeAdmissionBlocks(
      [
        ...Array.from({ length: 5 }, () => block({ itemId: 'WI-loop', atMs: 500 })),
        ...Array.from({ length: 30 }, (_, i) => block({ itemId: `WI-${i}`, atMs: 1_000 + i })),
      ],
      50,
    );
    expect(rows.find((r) => r.itemId === 'WI-loop')?.occurrences).toBe(5);
  });

  it('returns an empty list for no input', () => {
    expect(dedupeAdmissionBlocks([])).toEqual([]);
  });
});
