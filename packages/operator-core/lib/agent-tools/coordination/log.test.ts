/**
 * log.test.ts — the operator coordLog SEAM (not the PG backend). The seam exists so the channel
 * modules `import { coordLog }` once while tests swap the backend via configureCoordLog. These
 * pin the swap + the workspace/fast-path resolvers against an injected fake backend — no PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import type { CoordEventLog } from '@papercusp/coordination/event-log';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { FLAGS } from '@papercusp/flags';
import { setFlagOverridesForTest } from '@papercusp/flags/test';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  coordLog,
  configureCoordLog,
  resetCoordLog,
  coordWorkspaceId,
  coordHasPgFastPath,
  coordScopeWorkspace,
  coordSql,
  refreshCoordPerWorkspace,
} from './log';

/** A fake CoordEventLog backend with vi.fn() methods + optional pg-ish extras (workspaceId/getSql). */
function fakeLog(extra: Partial<{ workspaceId: string; getSql: () => unknown }> = {}): CoordEventLog {
  return {
    appendLine: vi.fn(async () => {}),
    readLines: vi.fn(async () => []),
    putEvent: vi.fn(async () => {}),
    readEvents: vi.fn(async () => []),
    readEventsBounded: vi.fn(async () => []),
    readLinesBounded: vi.fn(async () => []),
    getEvent: vi.fn(async () => null),
    ...extra,
  } as unknown as CoordEventLog;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => resetCoordLog()); // restore the default PG backend so no swap leaks across tests

describe('coordScopeWorkspace — flag-gated coord partition (drives the cached flag deterministically)', () => {
  // coordScopeWorkspace() reads a SYNC machine-global cache of the
  // COORD_PER_WORKSPACE flag, warmed on module load + every flag change. Earlier
  // this test relied on the flag's ambient DEFAULT being OFF; once the flag
  // graduated default-ON (WI-599) that ambient read returned the active workspace
  // and the assertion broke. So each case now sets an explicit flag override and
  // awaits refreshCoordPerWorkspace() — testing BOTH directions, not the default.
  afterEach(async () => {
    setFlagOverridesForTest(null);
    await refreshCoordPerWorkspace(); // restore the cache to the ambient default
  });

  it('falls back to the shared partition when the per-workspace flag is OFF (the safe kill-switch default)', async () => {
    setFlagOverridesForTest({ [FLAGS.COORD_PER_WORKSPACE]: false });
    await refreshCoordPerWorkspace();
    expect(coordScopeWorkspace()).toBe(DEFAULT_COORD_WORKSPACE);
  });

  it('scopes to the active workspace when the per-workspace flag is ON', async () => {
    setFlagOverridesForTest({ [FLAGS.COORD_PER_WORKSPACE]: true });
    await refreshCoordPerWorkspace();
    expect(coordScopeWorkspace()).toBe(activeWorkspaceId());
  });
});

describe('coordWorkspaceId — backend workspace, else default', () => {
  it('returns the configured backend\'s workspaceId when it exposes one', () => {
    configureCoordLog(fakeLog({ workspaceId: 'ws-42' }));
    expect(coordWorkspaceId()).toBe('ws-42');
  });

  it('falls back to the default when the backend exposes no workspaceId (in-memory double)', () => {
    configureCoordLog(fakeLog());
    expect(coordWorkspaceId()).toBe(DEFAULT_COORD_WORKSPACE);
  });
});

describe('coordHasPgFastPath — true only when the backend has a getSql handle', () => {
  it('true when the backend exposes getSql', () => {
    configureCoordLog(fakeLog({ getSql: () => ({}) }));
    expect(coordHasPgFastPath()).toBe(true);
  });

  it('false for a backend without getSql (the fs/in-memory double)', () => {
    configureCoordLog(fakeLog());
    expect(coordHasPgFastPath()).toBe(false);
  });
});

describe('coordSql — the backend\'s own handle', () => {
  it('returns the configured backend\'s getSql() result (never independently reaching for getOrgPg)', () => {
    const handle = { tag: 'the-seam-handle' };
    configureCoordLog(fakeLog({ getSql: () => handle }));
    expect(coordSql()).toBe(handle);
  });
});

describe('coordLog — delegates to the currently-configured backend', () => {
  it('forwards each call to the swapped backend, and resetCoordLog restores a pg-fast-path backend', async () => {
    const fake = fakeLog();
    configureCoordLog(fake);
    const env = { ts: '2026-06-23T12:00:00.000Z', msg_id: 'm1', from: 'a', to: ['*'], kind: 'message' } as CoordEnvelope;

    await coordLog.appendLine('messages', 'writer-key', env);
    await coordLog.readLines('plan-events');
    await coordLog.readEvents('handoffs');

    expect(fake.appendLine).toHaveBeenCalledWith('messages', 'writer-key', env);
    expect(fake.readLines).toHaveBeenCalledWith('plan-events', undefined);
    expect(fake.readEvents).toHaveBeenCalledWith('handoffs');
    expect(coordHasPgFastPath()).toBe(false); // the fake has no getSql

    resetCoordLog(); // back to the default PgCoordLog (which carries the getSql fast path)
    expect(coordHasPgFastPath()).toBe(true);
  });
});
