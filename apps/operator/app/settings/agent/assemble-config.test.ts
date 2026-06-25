/**
 * Tests for the /settings/agent auto-save assembly — the regression suite for
 * "saved a model spec, reloaded, the setting was wiped" (2026-06-11): an
 * invalid or incomplete edit must HOLD the affected section at its last saved
 * value, never silently drop entries from the persisted config.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_TIERS,
  SURFACE_KEYS,
  type ModelTier,
  type SurfaceKey,
} from '@papercusp/operator-core/lib/agent-config-constants';
import {
  assembleAgentConfig,
  modelSpecError,
  modelsJsonError,
  tierToRow,
  type AssembleInput,
  type LastValidSections,
} from './assemble-config';

const emptySurfaceBackends = Object.fromEntries(SURFACE_KEYS.map((k) => [k, 'inherit'])) as AssembleInput['surfaceBackends'];
const emptySurfaceModels = Object.fromEntries(SURFACE_KEYS.map((k) => [k, ''])) as AssembleInput['surfaceModels'];

function lastValid(partial: Partial<LastValidSections> = {}): LastValidSections {
  return { models: {}, surfaceModels: {}, tiers: [], tierCeilings: {}, ...partial };
}

function input(partial: Partial<AssembleInput> = {}): AssembleInput {
  return {
    backend: 'omp',
    cmd: '',
    modelsJson: '',
    roleBackends: {},
    surfaceBackends: { ...emptySurfaceBackends },
    surfaceModels: { ...emptySurfaceModels },
    tierRows: DEFAULT_MODEL_TIERS.map(tierToRow),
    tierCeilings: {},
    lastValid: lastValid(),
    ...partial,
  };
}

const CUSTOM_TIERS: ModelTier[] = [
  { name: 'fast', spec: 'haiku' },
  { name: 'smart', spec: 'opus:high' },
];

describe('modelSpecError', () => {
  it('accepts known aliases, effort suffixes, full ids, provider ids, and empty', () => {
    for (const ok of ['', 'haiku', 'opus:high', 'fable:max', 'claude-opus-4-8', 'anthropic/claude-opus-4-8:high', 'gpt-5.5']) {
      expect(modelSpecError(ok), ok).toBeNull();
    }
  });

  it('rejects whitespace and bare unknown words (typos must not go live)', () => {
    expect(modelSpecError('opus :high')).toMatch(/invalid spec/);
    expect(modelSpecError('opush')).toMatch(/not a known model alias/);
    expect(modelSpecError('fable5')).toMatch(/not a known model alias/);
    expect(modelSpecError('opush:high')).toMatch(/not a known model alias/);
  });
});

describe('modelsJsonError', () => {
  it('accepts empty, and role→spec objects with valid specs', () => {
    expect(modelsJsonError('')).toBeNull();
    expect(modelsJsonError('{"worker": "haiku", "reviewer": "anthropic/claude-opus-4-8"}')).toBeNull();
  });

  it('rejects broken JSON, non-objects, non-string values, and typo specs', () => {
    expect(modelsJsonError('{"worker": ')).toMatch(/invalid JSON/);
    expect(modelsJsonError('["worker"]')).toMatch(/JSON object/);
    expect(modelsJsonError('{"worker": 3}')).toMatch(/model id string/);
    expect(modelsJsonError('{"worker": ""}')).toMatch(/model id string/);
    expect(modelsJsonError('{"worker": "opsu"}')).toMatch(/not a known model alias/);
  });
});

describe('assembleAgentConfig — happy path', () => {
  it('persists a customized tier menu and advances lastValid', () => {
    const rows = DEFAULT_MODEL_TIERS.map(tierToRow);
    rows[3] = { ...rows[3], spec: 'fable:max' };
    const res = assembleAgentConfig(input({ tierRows: rows }));
    expect(res.problems).toEqual([]);
    expect(res.persistable.tiers).toHaveLength(4);
    expect(res.persistable.tiers[3]).toMatchObject({ name: 'max', spec: 'fable:max' });
    expect(res.lastValid.tiers).toEqual(res.persistable.tiers);
  });

  it('collapses an untouched default menu to [] so it tracks future defaults', () => {
    const res = assembleAgentConfig(input());
    expect(res.persistable.tiers).toEqual([]);
    expect(res.problems).toEqual([]);
  });

  it('keeps ceilings that name default tiers while the menu is default ([])', () => {
    const res = assembleAgentConfig(input({ tierCeilings: { bee: 'deep' } }));
    expect(res.persistable.tiers).toEqual([]);
    expect(res.persistable.tierCeilings).toEqual({ bee: 'deep' });
  });

  it('persists per-role backend overrides and drops inherit choices', () => {
    const res = assembleAgentConfig(input({
      roleBackends: { queen: 'codex', overwatch: 'inherit', 'release-manager': 'omp' },
    }));
    expect(res.persistable.roleBackends).toEqual({ queen: 'codex', 'release-manager': 'omp' });
  });

  it('skips fully blank tier rows (a just-added row) without flagging', () => {
    const rows = [...DEFAULT_MODEL_TIERS.map(tierToRow), { name: '', spec: '', backend: '' as const, when: '' }];
    const res = assembleAgentConfig(input({ tierRows: rows }));
    expect(res.problems).toEqual([]);
    expect(res.persistable.tiers).toEqual([]); // still the default menu
  });
});

describe('assembleAgentConfig — THE WIPE REGRESSION: invalid edits hold, never delete', () => {
  it('an incomplete tier row holds the whole menu at the last saved value', () => {
    const rows = CUSTOM_TIERS.map(tierToRow);
    rows[1] = { ...rows[1], spec: '' }; // user cleared the spec mid-edit
    const res = assembleAgentConfig(input({ tierRows: rows, lastValid: lastValid({ tiers: CUSTOM_TIERS }) }));
    expect(res.persistable.tiers).toEqual(CUSTOM_TIERS); // NOT a 1-row menu
    expect(res.problems.join('\n')).toMatch(/needs both a name and a model spec/);
    expect(res.problems.join('\n')).toMatch(/keeping the last saved menu/);
    expect(res.lastValid.tiers).toEqual(CUSTOM_TIERS); // fallback not advanced
  });

  it('a duplicate tier name holds the menu instead of dropping the row', () => {
    const rows = CUSTOM_TIERS.map(tierToRow);
    rows[1] = { ...rows[1], name: 'FAST' }; // dupe (case-insensitive)
    const res = assembleAgentConfig(input({ tierRows: rows, lastValid: lastValid({ tiers: CUSTOM_TIERS }) }));
    expect(res.persistable.tiers).toEqual(CUSTOM_TIERS);
    expect(res.problems.join('\n')).toMatch(/duplicate name/);
  });

  it('an invalid spec holds the menu instead of dropping the row', () => {
    const rows = CUSTOM_TIERS.map(tierToRow);
    rows[0] = { ...rows[0], spec: 'opus:' }; // mid-typed effort suffix
    const res = assembleAgentConfig(input({ tierRows: rows, lastValid: lastValid({ tiers: CUSTOM_TIERS }) }));
    expect(res.persistable.tiers).toEqual(CUSTOM_TIERS);
    expect(res.problems.join('\n')).toMatch(/invalid spec/);
  });

  it('a dangling ceiling holds the ceilings section at the last saved value', () => {
    const res = assembleAgentConfig(input({
      tierRows: CUSTOM_TIERS.map(tierToRow),
      tierCeilings: { bee: 'gone-tier' },
      lastValid: lastValid({ tiers: CUSTOM_TIERS, tierCeilings: { bee: 'smart' } }),
    }));
    expect(res.persistable.tierCeilings).toEqual({ bee: 'smart' });
    expect(res.problems.join('\n')).toMatch(/unknown tier "gone-tier"/);
  });

  it('an invalid surface model holds the surface models at the last saved value', () => {
    const stored = { oracle: 'opus' } as Partial<Record<SurfaceKey, string>>;
    const res = assembleAgentConfig(input({
      surfaceModels: { ...emptySurfaceModels, oracle: 'opsu' },
      lastValid: lastValid({ surfaceModels: stored }),
    }));
    expect(res.persistable.surfaceModels).toEqual(stored);
    expect(res.problems.join('\n')).toMatch(/not a known model alias/);
  });

  it('an invalid models JSON holds the per-role overrides at the last saved value', () => {
    const stored = { worker: 'haiku' };
    const res = assembleAgentConfig(input({
      modelsJson: '{"worker": "opsu"}',
      lastValid: lastValid({ models: stored }),
    }));
    expect(res.persistable.models).toEqual(stored);
    expect(res.problems.join('\n')).toMatch(/keeping the last saved overrides/);
  });

  it('a tier problem does not block the REST of the page from persisting', () => {
    const rows = CUSTOM_TIERS.map(tierToRow);
    rows[0] = { ...rows[0], spec: '' };
    const res = assembleAgentConfig(input({
      cmd: 'claude -p',
      modelsJson: '{"worker": "sonnet"}',
      tierRows: rows,
      lastValid: lastValid({ tiers: CUSTOM_TIERS }),
    }));
    expect(res.persistable.cmd).toBe('claude -p');
    expect(res.persistable.models).toEqual({ worker: 'sonnet' });
    expect(res.persistable.tiers).toEqual(CUSTOM_TIERS);
  });

  it('clearing the models JSON intentionally clears the overrides (not a hold)', () => {
    const res = assembleAgentConfig(input({
      modelsJson: '',
      lastValid: lastValid({ models: { worker: 'haiku' } }),
    }));
    expect(res.persistable.models).toEqual({});
    expect(res.lastValid.models).toEqual({});
    expect(res.problems).toEqual([]);
  });
});
