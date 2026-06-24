/**
 * scout-budget-overrides.test.ts — live-configurability-audit-2026-06-20 P-022.
 *
 * The runtime Scout workspace spend-ceiling override resolution order: PG override ?? env ?? default,
 * exercised PG-free via the injectable `readOverride` + `env` deps.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOUT_WORKSPACE_CEILING_USD } from './core';
import {
  resolveScoutWorkspaceCeilingUsd,
  resolveScoutWorkspaceCeilingUsdLive,
  type ScoutBudgetOverrides,
} from './scout-budget-overrides';

const override = (o: ScoutBudgetOverrides) => () => Promise.resolve(o);

describe('resolveScoutWorkspaceCeilingUsd (env base layer)', () => {
  it('defaults when env is unset/empty', () => {
    expect(resolveScoutWorkspaceCeilingUsd({})).toBe(DEFAULT_SCOUT_WORKSPACE_CEILING_USD);
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
  });
  it('honours a finite ≥ 0 env value (including 0)', () => {
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' })).toBe(25);
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '0' })).toBe(0);
  });
  it('falls back to default on a non-numeric / negative env value', () => {
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: 'nope' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
    expect(resolveScoutWorkspaceCeilingUsd({ PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '-5' })).toBe(
      DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
    );
  });
});

describe('resolveScoutWorkspaceCeilingUsdLive (override ?? env ?? default)', () => {
  it('uses the PG override when set (winning over the env)', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({
      readOverride: override({ workspaceCeilingUsd: 3 }),
      env: { PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' },
    });
    expect(v).toBe(3);
  });

  it('honours an override of 0 (an honest "no scout spend" cap)', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({
      readOverride: override({ workspaceCeilingUsd: 0 }),
      env: { PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' },
    });
    expect(v).toBe(0);
  });

  it('falls through to the env when no override is set', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({
      readOverride: override({}),
      env: { PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' },
    });
    expect(v).toBe(25);
  });

  it('falls through to the default when neither override nor env is set', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({ readOverride: override({}), env: {} });
    expect(v).toBe(DEFAULT_SCOUT_WORKSPACE_CEILING_USD);
  });

  it('ignores an invalid (negative / non-finite) override value, falling through to env', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({
      readOverride: override({ workspaceCeilingUsd: -1 }),
      env: { PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '25' },
    });
    expect(v).toBe(25);
  });

  it('fails open to env/default when the override read throws', async () => {
    const v = await resolveScoutWorkspaceCeilingUsdLive({
      readOverride: () => Promise.reject(new Error('pg down')),
      env: { PAPERCUSP_SCOUT_WORKSPACE_CEILING_USD: '7' },
    });
    expect(v).toBe(7);
  });
});
