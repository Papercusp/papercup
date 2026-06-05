import { describe, test, expect } from 'vitest';
import {
  dbosOrchestratorActive,
  dbosAutoloopActive,
  dbosTimersActive,
  dbosProvisionActive,
  dbosBackupActive,
  dbosCurationActive,
} from './dbos-flags';

type Env = Record<string, string | undefined>;

describe('dbosOrchestratorActive — default-on since P-009 (off only when =0)', () => {
  test('unset → active (default)', () => expect(dbosOrchestratorActive({})).toBe(true));
  test('=1 → active', () => expect(dbosOrchestratorActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '1' })).toBe(true));
  test('=0 → the legacy revert', () => expect(dbosOrchestratorActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
});

describe('dbosAutoloopActive — Option 2: default-on with the orchestrator', () => {
  test('unset → active (default-on with orchestrator)', () =>
    expect(dbosAutoloopActive({})).toBe(true));
  test('AUTOLOOP=0 → disabled (just the autoloop)', () =>
    expect(dbosAutoloopActive({ PAPERCUSP_DBOS_AUTOLOOP: '0' })).toBe(false));
  test('ORCHESTRATOR=0 → off (full legacy revert turns the autoloop off too)', () =>
    expect(dbosAutoloopActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
  test('AUTOLOOP=1 explicit → active', () =>
    expect(dbosAutoloopActive({ PAPERCUSP_DBOS_AUTOLOOP: '1' })).toBe(true));
});

describe('dbosTimersActive — Phase-2 timers default-on with the orchestrator', () => {
  test('unset → active', () => expect(dbosTimersActive({})).toBe(true));
  test('TIMERS=0 → disabled (just the timers)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_TIMERS: '0' })).toBe(false));
  test('ORCHESTRATOR=0 → off (full legacy revert)', () =>
    expect(dbosTimersActive({ PAPERCUSP_DBOS_ORCHESTRATOR: '0' })).toBe(false));
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
