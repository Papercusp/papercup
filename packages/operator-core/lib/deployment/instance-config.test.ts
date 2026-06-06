import { describe, it, expect } from 'vitest';
import { splitConfigJson, hasInstanceConfig, instanceEntryToConfig } from './instance-config';

describe('splitConfigJson', () => {
  it('splits instance fields (phase/phases/dept) from per-instance knob overrides', () => {
    expect(
      splitConfigJson({
        phase: 'staging',
        phases: { staging: { port: 3055 } },
        dept: 'eng',
        maxCostUsd: 10,
        parallelWorkers: { max: 4 },
        harness_kind: 'coding', // shape-ish — excluded from overrides
      }),
    ).toEqual({
      phase: 'staging',
      phases: { staging: { port: 3055 } },
      dept: 'eng',
      configOverrides: { maxCostUsd: 10, parallelWorkers: { max: 4 } },
    });
  });

  it('no knob overrides → no configOverrides key', () => {
    expect(splitConfigJson({ phase: 'staging' })).toEqual({ phase: 'staging' });
  });

  it('only overrides → no instance fields', () => {
    expect(splitConfigJson({ maxCostUsd: 5 })).toEqual({ configOverrides: { maxCostUsd: 5 } });
  });

  it('empty config → empty', () => {
    expect(splitConfigJson({})).toEqual({});
  });

  it('contract artifacts (harness_token/parent_slug/slug) are NOT swept into configOverrides (D-005)', () => {
    expect(
      splitConfigJson({
        phase: 'staging',
        harness_token: 'secret',
        parent_slug: 'root',
        slug: 'child',
        maxCostUsd: 7,
      }),
    ).toEqual({
      phase: 'staging',
      configOverrides: { maxCostUsd: 7 },
    });
  });
});

describe('hasInstanceConfig', () => {
  it('true when any instance field is present', () => {
    expect(hasInstanceConfig({ phase: 'staging' })).toBe(true);
    expect(hasInstanceConfig({ configOverrides: { maxCostUsd: 1 } })).toBe(true);
    expect(hasInstanceConfig({})).toBe(false);
  });
});

describe('instanceEntryToConfig round-trip', () => {
  it('re-assembles the flat config from split fields', () => {
    const cfg = { phase: 'production', phases: { production: { port: 80 } }, dept: 'eng', maxCostUsd: 10, parallelWorkers: { max: 8 } };
    const split = splitConfigJson(cfg);
    expect(instanceEntryToConfig(split)).toEqual(cfg);
  });

  it('empty entry → empty config', () => {
    expect(instanceEntryToConfig({})).toEqual({});
  });
});
