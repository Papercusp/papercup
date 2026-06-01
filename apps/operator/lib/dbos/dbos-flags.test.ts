import { describe, test, expect } from 'vitest';
import { dbosOrchestratorActive, dbosAutoloopActive, dbosTimersActive } from './dbos-flags';

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
