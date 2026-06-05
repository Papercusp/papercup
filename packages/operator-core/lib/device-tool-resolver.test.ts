import { describe, expect, it } from 'vitest';

import {
  normalizeRegistryId,
  resolveRegistryToolId,
  type ToolDef,
  type ToolRegistry,
} from './device-tool-resolver';

function makeRegistry(defs: ToolDef[]): ToolRegistry {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    get: (id) => byId.get(id),
    list: () => defs,
  };
}

describe('normalizeRegistryId', () => {
  it('replaces dots and dashes with underscores', () => {
    expect(normalizeRegistryId('harness.status')).toBe('harness_status');
    expect(normalizeRegistryId('harness.list-features')).toBe('harness_list_features');
    expect(normalizeRegistryId('a-b.c-d.e')).toBe('a_b_c_d_e');
  });
  it('leaves underscore-form alone', () => {
    expect(normalizeRegistryId('already_underscores')).toBe('already_underscores');
  });
  it('handles ids with neither dots nor dashes', () => {
    expect(normalizeRegistryId('simple')).toBe('simple');
  });
});

describe('resolveRegistryToolId — stage 1 (literal match)', () => {
  it('returns the id when the agent used the dotted form already', () => {
    const reg = makeRegistry([{ id: 'harness.status' }]);
    expect(resolveRegistryToolId('harness.status', reg)).toBe('harness.status');
  });
});

describe('resolveRegistryToolId — stage 2 (underscore → dot)', () => {
  it('resolves a simple underscore form', () => {
    const reg = makeRegistry([{ id: 'harness.status' }]);
    expect(resolveRegistryToolId('harness_status', reg)).toBe('harness.status');
  });
  it('does not try the dot conversion when no underscores are present', () => {
    const reg = makeRegistry([{ id: 'panel.cards' }]);
    expect(resolveRegistryToolId('panel.cards', reg)).toBe('panel.cards');
  });
});

describe('resolveRegistryToolId — stage 3 (normalized-form scan)', () => {
  it('resolves IDs with mixed dots + dashes that stage 2 alone cannot', () => {
    const reg = makeRegistry([{ id: 'harness.list-features' }]);
    // Stage 2 would produce 'harness.list.features' which doesn't exist.
    // Stage 3 normalizes the registry id and compares.
    expect(resolveRegistryToolId('harness_list_features', reg)).toBe('harness.list-features');
  });
  it('handles all-underscore registry ids (degenerate case)', () => {
    const reg = makeRegistry([{ id: 'already_underscores' }]);
    expect(resolveRegistryToolId('already_underscores', reg)).toBe('already_underscores');
  });
});

describe('resolveRegistryToolId — non-matches', () => {
  it('returns undefined when no match in any stage', () => {
    const reg = makeRegistry([{ id: 'harness.status' }, { id: 'nav.open-harness' }]);
    expect(resolveRegistryToolId('definitely_not_a_tool', reg)).toBeUndefined();
    expect(resolveRegistryToolId('', reg)).toBeUndefined();
    expect(resolveRegistryToolId('harness-status', reg)).toBeUndefined();
  });
});

describe('resolveRegistryToolId — order of resolution', () => {
  it('prefers literal match over underscore-to-dot when both exist', () => {
    const reg = makeRegistry([
      { id: 'op_pause' }, // literal hit
      { id: 'op.pause' }, // would also match via stage 2
    ]);
    expect(resolveRegistryToolId('op_pause', reg)).toBe('op_pause');
  });
});

describe('resolveRegistryToolId — real-world catalog', () => {
  const catalog: ToolDef[] = [
    { id: 'harness.status' },
    { id: 'harness.list' },
    { id: 'harness.list-features' },
    { id: 'harness.start' },
    { id: 'operator.pause' },
    { id: 'operator.resume' },
    { id: 'nav.open-harness' },
    { id: 'panel.cards' },
    { id: 'panel.dispatch-card' },
    { id: 'workspace.switch' },
    { id: 'voice.claim' },
    { id: 'voice.set-mode' },
  ];

  it('resolves every EL-form name to the right canonical id', () => {
    const reg = makeRegistry(catalog);
    const cases: Array<[string, string]> = [
      ['harness_status', 'harness.status'],
      ['harness_list', 'harness.list'],
      ['harness_list_features', 'harness.list-features'],
      ['harness_start', 'harness.start'],
      ['operator_pause', 'operator.pause'],
      ['operator_resume', 'operator.resume'],
      ['nav_open_harness', 'nav.open-harness'],
      ['panel_cards', 'panel.cards'],
      ['panel_dispatch_card', 'panel.dispatch-card'],
      ['workspace_switch', 'workspace.switch'],
      ['voice_claim', 'voice.claim'],
      ['voice_set_mode', 'voice.set-mode'],
    ];
    for (const [elName, expectedId] of cases) {
      expect(resolveRegistryToolId(elName, reg)).toBe(expectedId);
    }
  });
});
