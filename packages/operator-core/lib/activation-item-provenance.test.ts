import { describe, expect, it } from 'vitest';
import type { HitTurnOriginVerdict } from './agent-tools/sessions/turn-origin';
import {
  isOwnerTurnVerdict,
  itemProvenanceLabelText,
  resolveItemProvenance,
  validateItemProvenanceDeclarations,
  type ProvenanceMappingInput,
} from './activation-item-provenance';

const OWNER = 'session_turn:claude:s1:0';
const OWNER_DIALOG = 'session_turn:claude:s1:4';
const ASSISTANT = 'session_turn:claude:s1:1';
const LOOP_FIRE = 'session_turn:claude:s1:2';
const MACHINE = 'session_turn:claude:s1:3';
const UNREADABLE = 'session_turn:claude:s1:99';

const verdicts: Record<string, HitTurnOriginVerdict> = {
  [OWNER]: 'owner-typed',
  [OWNER_DIALOG]: 'owner-dialog',
  [ASSISTANT]: 'not-user-turn',
  [LOOP_FIRE]: 'agent-injected',
  [MACHINE]: 'machine-surface',
};
const originOf = (ref: string) => verdicts[ref];

function mapping(id: string, sourceRefs: string[], planTargets: string[], disposition: ProvenanceMappingInput['disposition'] = 'covered'): ProvenanceMappingInput {
  return { id, sourceRefs, planTargets, disposition };
}

describe('resolveItemProvenance — R-1: an agent quoting itself does not count as the owner', () => {
  it('assistant, machine-injected and unknown-origin refs alone never make an item owner-sourced', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [ASSISTANT, LOOP_FIRE, MACHINE, UNREADABLE], ['P-001'])],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ itemId: 'P-001', label: 'unresolved', reason: 'no_owner_ref' });
    expect(result.items[0]!.refs.map((ref) => [ref.verdict, ref.owner])).toEqual([
      ['not-user-turn', false],
      ['agent-injected', false],
      ['machine-surface', false],
      ['unknown', false],
    ]);
    expect(result.unresolved).toEqual(['P-001']);
  });

  it('the same mapping with one owner-typed ref makes the item owner-sourced', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [ASSISTANT, LOOP_FIRE, MACHINE, UNREADABLE, OWNER], ['P-001'])],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ itemId: 'P-001', label: 'owner', mappingIds: ['M-001'] });
    expect(result.items[0]!.reason).toBeUndefined();
    expect(result.counts).toEqual({ owner: 1, derived: 0, 'agent-added': 0, unresolved: 0 });
  });

  it('owner-dialog answers (AskUserQuestion) count as owner speech', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-002'],
      mappings: [mapping('M-002', [OWNER_DIALOG], ['P-002'])],
      originOf,
    });
    expect(result.items[0]!.label).toBe('owner');
  });

  it('a rejected mapping never backs its targets, even with an owner ref', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-003'],
      mappings: [mapping('M-003', [OWNER], ['P-003'], 'rejected')],
      originOf,
    });
    expect(result.items[0]).toMatchObject({ label: 'unresolved', reason: 'no_mapping', mappingIds: [] });
  });

  it('an agent-added declaration cannot override owner backing', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001'],
      mappings: [mapping('M-001', [OWNER], ['P-001'])],
      originOf,
      declarations: [{ itemId: 'P-001', kind: 'agent-added', reason: 'mine' }],
    });
    expect(result.items[0]!.label).toBe('owner');
  });
});

describe('resolveItemProvenance — derived and agent-added declarations', () => {
  it('derived from an owner-backed decision or item resolves as derived', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002', 'P-003'],
      mappings: [mapping('M-001', [OWNER], ['P-001', 'D-001'])],
      originOf,
      declarations: [
        { itemId: 'P-002', kind: 'derived', from: ['D-001'] },
        { itemId: 'P-003', kind: 'derived', from: ['P-002'] },
      ],
    });
    expect(result.items.map((item) => [item.itemId, item.label])).toEqual([
      ['P-001', 'owner'],
      ['P-002', 'derived'],
      ['P-003', 'derived'],
    ]);
    expect(result.items[1]!.derivedFrom).toEqual(['D-001']);
  });

  it('derivation cannot launder an agent-only source into owner backing', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [mapping('M-001', [ASSISTANT], ['P-001', 'D-001'])],
      originOf,
      declarations: [{ itemId: 'P-002', kind: 'derived', from: ['D-001', 'P-001'] }],
    });
    expect(result.items[1]).toMatchObject({ label: 'unresolved', reason: 'derived_source_not_owner_backed' });
  });

  it('a derivation cycle with no owner anchor never resolves', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [],
      originOf,
      declarations: [
        { itemId: 'P-001', kind: 'derived', from: ['P-002'] },
        { itemId: 'P-002', kind: 'derived', from: ['P-001'] },
      ],
    });
    expect(result.unresolved).toEqual(['P-001', 'P-002']);
  });

  it('agent-added needs a non-empty reason', () => {
    const result = resolveItemProvenance({
      itemIds: ['P-001', 'P-002'],
      mappings: [],
      originOf,
      declarations: [
        { itemId: 'P-001', kind: 'agent-added', reason: 'regression test the owner did not ask for' },
        { itemId: 'P-002', kind: 'agent-added', reason: '   ' },
      ],
    });
    expect(result.items[0]).toMatchObject({ label: 'agent-added', agentReason: 'regression test the owner did not ask for' });
    expect(result.items[1]).toMatchObject({ label: 'unresolved', reason: 'agent_added_reason_missing' });
  });
});

describe('validateItemProvenanceDeclarations', () => {
  it('collects every structural problem', () => {
    const problems = validateItemProvenanceDeclarations(
      [
        { itemId: 'P-009', kind: 'agent-added', reason: 'x' },
        { itemId: 'P-001', kind: 'derived', from: [' '] },
        { itemId: 'P-001', kind: 'agent-added', reason: '' },
      ],
      ['P-001'],
    );
    expect(problems.map((problem) => [problem.itemId, problem.code])).toEqual([
      ['P-009', 'provenance_item_unknown'],
      ['P-001', 'provenance_derived_from_empty'],
      ['P-001', 'provenance_item_duplicate'],
      ['P-001', 'provenance_reason_empty'],
    ]);
  });
});

describe('labels', () => {
  it('only the three owner verdicts are owner speech', () => {
    expect(['owner-typed', 'owner-turn', 'owner-dialog'].every((v) => isOwnerTurnVerdict(v as HitTurnOriginVerdict))).toBe(true);
    expect(['agent-injected', 'machine-surface', 'synthetic', 'not-user-turn', 'unknown'].some((v) => isOwnerTurnVerdict(v as HitTurnOriginVerdict))).toBe(false);
    expect(itemProvenanceLabelText('agent-added')).toBe('Added by the agent');
  });
});
