/**
 * seat-slots.test.ts — the /res Agent-seats pure helpers (P-003,
 * agent-allocation-framework-2026-07-03). Locks the client mirror of the
 * P-001 store contract: derived ref `${model}:${effort}:${account}`, quantity
 * band 1..1000, tier-spec → (model, effort) parsing (last-colon effort rule,
 * `[1m]` marker preserved), and the merge/retarget write planning.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_SLOT_MAX_QUANTITY,
  AUTO_ACCOUNT,
  DEFAULT_SEAT_EFFORT,
  agentSlotRef,
  clampSeatQuantity,
  parseTierSpecToSlot,
  planSlotWrite,
  slotChipLabel,
  toSlotRow,
  type SlotRow,
} from './seat-slots';

const axis = (model: string, effort: string, account: string) =>
  ({ model, effort, account }) as SlotRow['axis'];

describe('agentSlotRef', () => {
  it('derives the D-002 template ref', () => {
    expect(agentSlotRef(axis('opus[1m]', 'xhigh', 'AUTO'))).toBe('opus[1m]:xhigh:AUTO');
    expect(agentSlotRef(axis('haiku', 'low', 'acct-1'))).toBe('haiku:low:acct-1');
  });
});

describe('parseTierSpecToSlot', () => {
  it('splits an effort-suffixed spec on the LAST colon', () => {
    expect(parseTierSpecToSlot('opus[1m]:high')).toEqual({ model: 'opus[1m]', effort: 'high' });
    expect(parseTierSpecToSlot('opus[1m]:xhigh')).toEqual({ model: 'opus[1m]', effort: 'xhigh' });
  });

  it('keeps the [1m] window marker on the model (the sonnet fleet-killer guard)', () => {
    expect(parseTierSpecToSlot('sonnet[1m]')?.model).toBe('sonnet[1m]');
  });

  it('defaults a bare spec to DEFAULT_SEAT_EFFORT', () => {
    expect(parseTierSpecToSlot('haiku')).toEqual({ model: 'haiku', effort: DEFAULT_SEAT_EFFORT });
  });

  it('treats a non-effort colon suffix as part of the model id — then refuses it as a slot (colons are ref separators)', () => {
    // 'us.anthropic.claude:v2' — suffix not an effort ⇒ model keeps the colon ⇒ un-representable.
    expect(parseTierSpecToSlot('us.anthropic.claude:v2')).toBeNull();
  });

  it('refuses empty / whitespace specs', () => {
    expect(parseTierSpecToSlot('')).toBeNull();
    expect(parseTierSpecToSlot('  ')).toBeNull();
    expect(parseTierSpecToSlot('a b')).toBeNull();
  });

  it('parses a model-with-colon + effort suffix by the last-colon rule', () => {
    expect(parseTierSpecToSlot('vendor:model:high')).toBeNull(); // model 'vendor:model' still has ':'
  });
});

describe('clampSeatQuantity', () => {
  it('clamps into 1..AGENT_SLOT_MAX_QUANTITY', () => {
    expect(clampSeatQuantity(0)).toBe(1);
    expect(clampSeatQuantity(-5)).toBe(1);
    expect(clampSeatQuantity(5)).toBe(5);
    expect(clampSeatQuantity(AGENT_SLOT_MAX_QUANTITY + 1)).toBe(AGENT_SLOT_MAX_QUANTITY);
    expect(clampSeatQuantity(Number.NaN)).toBe(1);
    expect(clampSeatQuantity(2.6)).toBe(3);
  });
});

describe('planSlotWrite', () => {
  const existing: SlotRow[] = [
    { ref: 'opus[1m]:xhigh:AUTO', quantity: 5, axis: axis('opus[1m]', 'xhigh', 'AUTO') },
    { ref: 'haiku:low:acct-1', quantity: 2, axis: axis('haiku', 'low', 'acct-1') },
  ];

  it('fresh drop → quantity 1, no removal', () => {
    const p = planSlotWrite(existing, axis('sonnet[1m]', 'high', 'AUTO'), 1);
    expect(p).toEqual({ set: { axis: axis('sonnet[1m]', 'high', 'AUTO'), quantity: 1 } });
  });

  it('drop onto an existing template → increments (merge)', () => {
    const p = planSlotWrite(existing, axis('opus[1m]', 'xhigh', 'AUTO'), 1);
    expect(p.set.quantity).toBe(6);
    expect(p.removeRef).toBeUndefined();
  });

  it('count step on the same ref → plain upsert of the new count, no merge double-count', () => {
    const p = planSlotWrite(existing, axis('opus[1m]', 'xhigh', 'AUTO'), 4, 'opus[1m]:xhigh:AUTO');
    expect(p).toEqual({ set: { axis: axis('opus[1m]', 'xhigh', 'AUTO'), quantity: 4 } });
  });

  it('account retarget onto a FREE ref → moves the count and removes the old row', () => {
    const p = planSlotWrite(existing, axis('opus[1m]', 'xhigh', 'acct-1'), 5, 'opus[1m]:xhigh:AUTO');
    expect(p.set).toEqual({ axis: axis('opus[1m]', 'xhigh', 'acct-1'), quantity: 5 });
    expect(p.removeRef).toBe('opus[1m]:xhigh:AUTO');
  });

  it('account retarget onto an OCCUPIED ref → sums quantities and removes the old row', () => {
    const p = planSlotWrite(
      [...existing, { ref: 'opus[1m]:xhigh:acct-1', quantity: 3, axis: axis('opus[1m]', 'xhigh', 'acct-1') }],
      axis('opus[1m]', 'xhigh', 'acct-1'),
      5,
      'opus[1m]:xhigh:AUTO',
    );
    expect(p.set.quantity).toBe(8);
    expect(p.removeRef).toBe('opus[1m]:xhigh:AUTO');
  });

  it('merge clamps at the store band', () => {
    const p = planSlotWrite(
      [{ ref: 'opus[1m]:xhigh:AUTO', quantity: AGENT_SLOT_MAX_QUANTITY, axis: axis('opus[1m]', 'xhigh', 'AUTO') }],
      axis('opus[1m]', 'xhigh', 'AUTO'),
      1,
    );
    expect(p.set.quantity).toBe(AGENT_SLOT_MAX_QUANTITY);
  });
});

describe('slotChipLabel', () => {
  it("renders 'N × model·effort' (account lives in the select)", () => {
    expect(slotChipLabel({ ref: 'r', quantity: 5, axis: axis('opus[1m]', 'xhigh', AUTO_ACCOUNT) })).toBe(
      '5 × opus[1m]·xhigh',
    );
  });
});

describe('toSlotRow', () => {
  it('projects a well-formed agent_slot row', () => {
    expect(
      toSlotRow({
        resourceKind: 'agent_slot',
        resourceRef: 'opus[1m]:xhigh:AUTO',
        quantity: 5,
        axis: { model: 'opus[1m]', effort: 'xhigh', account: 'AUTO' },
      }),
    ).toEqual({ ref: 'opus[1m]:xhigh:AUTO', quantity: 5, axis: axis('opus[1m]', 'xhigh', 'AUTO') });
  });

  it('rejects non-slot kinds and degraded pre-mig-486 rows instead of crashing the board', () => {
    expect(toSlotRow({ resourceKind: 'account', resourceRef: 'a', quantity: null, axis: {} })).toBeNull();
    expect(toSlotRow({ resourceKind: 'agent_slot', resourceRef: 'r' })).toBeNull(); // no quantity/axis
    expect(
      toSlotRow({ resourceKind: 'agent_slot', resourceRef: 'r', quantity: 0, axis: { model: 'm', effort: 'high', account: 'AUTO' } }),
    ).toBeNull(); // zero-count never renders
    expect(
      toSlotRow({ resourceKind: 'agent_slot', resourceRef: 'r', quantity: 2, axis: { model: 'm', effort: 'nope', account: 'AUTO' } }),
    ).toBeNull(); // unknown effort
  });
});
