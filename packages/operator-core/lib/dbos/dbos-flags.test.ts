import { describe, test, expect } from 'vitest';
import {
  dbosOrchestratorActive,
  dbosTimersActive,
  dbosPeriodicTimersActive,
  dbosProvisionActive,
  dbosBackupActive,
  dbosCurationActive,
  dbosPlanRenderActive,
} from './dbos-flags';

type Env = Record<string, string | undefined>;

describe('dbosOrchestratorActive — default-on since P-009 (off only when =0)', () => {
  test('unset → active (default)', () => expect(dbosOrchestratorActive({})).toBe(true));
  test('=1 → active', () => expect(dbosOrchestratorActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '1' })).toBe(true));
  test('=0 → the legacy revert', () => expect(dbosOrchestratorActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
});

// dbosAutoloopActive is gone (autoloop-pot-operator-rebuild P-010 / D-009): the
// director-cadence autoloop is retired; scheduled fires are the routines
// engine's job (dbosRoutinesActive).

describe('dbosTimersActive — timers active only when DBOS actually launches (no-gap)', () => {
  // The legacy fallbacks (push-cred refresher, harness-status sweep) stand
  // down on this predicate, so it must be false whenever DBOS isn't launched
  // (ENABLE is the host-bootstrap launch gate, default OFF) — otherwise both
  // sides are off. Found live on staging: push creds never minted
  // (mobile-apps-revival D-004).
  test('fully unset → INACTIVE (DBOS never launches; legacy must run)', () =>
    expect(dbosTimersActive({})).toBe(false));
  test('ENABLE=0 → inactive (legacy must run)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_ENABLE: '0' })).toBe(false));
  test('ENABLE=1 → active (default-on with the orchestrator)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_ENABLE: '1' })).toBe(true));
  test('ENABLE=1 + TIMERS=0 → disabled (just the timers)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_ENABLE: '1', PAPERCUSP_DBOS_TIMERS: '0' })).toBe(false));
  test('ENABLE=1 + ORCHESTRATOR=0 → off (full legacy revert)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_ENABLE: '1', PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
});

describe('dbosPeriodicTimersActive — registration gate; UTILITY hosts skip the shared-DB drains (EI-596)', () => {
  // dbosTimersActive() stays the legacy-fallback stand-down predicate (unchanged);
  // this is the REGISTRATION gate and additionally excludes a utility host (the
  // gym-operator), whose throwaway DB has no backup config so the drains error.
  test('main host, timers active → registers (parity with dbosTimersActive)', () =>
    expect(dbosPeriodicTimersActive({ PAPERCUSP_DBOS_ENABLE: '1' })).toBe(true));
  test('UTILITY host with timers active → does NOT register the periodic drains', () =>
    expect(dbosPeriodicTimersActive({ PAPERCUSP_DBOS_ENABLE: '1', PAPERCUSP_UTILITY_HOST: '1' })).toBe(false));
  test('UTILITY host but timers off anyway → still false', () =>
    expect(dbosPeriodicTimersActive({ PAPERCUSP_UTILITY_HOST: '1' })).toBe(false));
  test('main host but DBOS not launched → false (inherits the dbosTimersActive no-gap gate)', () =>
    expect(dbosPeriodicTimersActive({ PAPERCUSP_DBOS_ENABLE: '0' })).toBe(false));
  test('main host, timers explicitly off → false', () =>
    expect(dbosPeriodicTimersActive({ PAPERCUSP_DBOS_ENABLE: '1', PAPERCUSP_DBOS_TIMERS: '0' })).toBe(false));
});

describe('dbosProvisionActive — default-on with the orchestrator (off only when =0)', () => {
  test('unset → active (default-on, like orchestrator/timers)', () =>
    expect(dbosProvisionActive({})).toBe(true));
  test('PROVISION=1 explicit → active', () =>
    expect(dbosProvisionActive({ PAPERCUSP_DBOS_PROVISION: '1' })).toBe(true));
  test('PROVISION=0 → the legacy claim-path revert', () =>
    expect(dbosProvisionActive({ PAPERCUSP_DBOS_PROVISION: '0' })).toBe(false));
  test('ORCHESTRATOR=0 forces it off too (full legacy revert)', () =>
    expect(dbosProvisionActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
});

describe('dbosBackupActive — opt-in (P-011), off until explicitly =1', () => {
  test('unset → inactive (fresh capability, opt-in)', () =>
    expect(dbosBackupActive({})).toBe(false));
  test('BACKUP=1 → active', () =>
    expect(dbosBackupActive({ PAPERCUSP_DBOS_BACKUP: '1' })).toBe(true));
  test('BACKUP=1 but ORCHESTRATOR=0 → off (master revert wins)', () =>
    expect(dbosBackupActive({ PAPERCUSP_DBOS_BACKUP: '1', PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
  test('BACKUP=0 → inactive', () =>
    expect(dbosBackupActive({ PAPERCUSP_DBOS_BACKUP: '0' })).toBe(false));
});

describe('dbosCurationActive — curator-operator P0, opt-in, off until =1', () => {
  test('unset → inactive (fresh capability that writes into the operator chat)', () =>
    expect(dbosCurationActive({})).toBe(false));
  test('CURATION=1 → active', () =>
    expect(dbosCurationActive({ PAPERCUSP_DBOS_CURATION: '1' })).toBe(true));
  test('CURATION=1 but ORCHESTRATOR=0 → off (master revert wins)', () =>
    expect(dbosCurationActive({ PAPERCUSP_DBOS_CURATION: '1', PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
  test('CURATION=0 → inactive', () =>
    expect(dbosCurationActive({ PAPERCUSP_DBOS_CURATION: '0' })).toBe(false));
});

describe('dbosPlanRenderActive — plan-markdown auto-render, opt-in, off until =1', () => {
  test('unset → inactive (fresh capability that writes the tracked tree)', () =>
    expect(dbosPlanRenderActive({})).toBe(false));
  test('PLAN_RENDER=1 → active', () =>
    expect(dbosPlanRenderActive({ PAPERCUSP_DBOS_PLAN_RENDER: '1' })).toBe(true));
  test('PLAN_RENDER=1 but ORCHESTRATOR=0 → off (master revert wins)', () =>
    expect(dbosPlanRenderActive({ PAPERCUSP_DBOS_PLAN_RENDER: '1', PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
  test('PLAN_RENDER=0 → inactive', () =>
    expect(dbosPlanRenderActive({ PAPERCUSP_DBOS_PLAN_RENDER: '0' })).toBe(false));
});
