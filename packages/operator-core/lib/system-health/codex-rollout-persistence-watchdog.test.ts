import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  endSession: vi.fn(async () => undefined),
  cancelInboxWake: vi.fn(async () => 0),
  cancelClaimable: vi.fn(async () => 0),
  retireLifecycleWatches: vi.fn(async () => ({ awaits: 0, predicateWatches: 0 })),
  releaseWorkItems: vi.fn(async () => ({ releasedIds: [], claimsCleared: 0 })),
  notifyAttention: vi.fn(async () => undefined),
}));

vi.mock('../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adv-sessions')>()),
  markAdvSessionEnded: lifecycleMocks.endSession,
}));
vi.mock('../events/await/store', () => ({
  cancelInboxWakeAwaits: lifecycleMocks.cancelInboxWake,
  cancelClaimableAwaits: lifecycleMocks.cancelClaimable,
  retireWatchesForReapedOwners: lifecycleMocks.retireLifecycleWatches,
}));
vi.mock('../work-item-lease-release', () => ({
  releaseAllWorkItemLeasesForOwner: lifecycleMocks.releaseWorkItems,
}));
vi.mock('../attention-notify', () => ({ notifyAttention: lifecycleMocks.notifyAttention }));

import {
  checkCodexRolloutPersistence,
  classifyCodexProviderError,
  evaluateCodexRolloutPersistence,
  evaluateCodexProviderFailureRecurrence,
  providerFailureDisposition,
  readCodexRolloutTail,
  scanCodexProviderFailureTail,
  type CodexRolloutPersistenceSnapshot,
} from './codex-rollout-persistence-watchdog';

const NOW = 1_000_000;
const base: CodexRolloutPersistenceSnapshot = {
  sessionId: '11801',
  ownerId: 'su-owner',
  pidAlive: true,
  historyMtimeMs: NOW - 60_000,
  rolloutMtimeMs: NOW - 60_000,
};

describe('evaluateCodexRolloutPersistence', () => {
  it('alarms when a live Codex process has fresh history but no rollout file', () => {
    const verdict = evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: null }, NOW);
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('no rollout JSONL exists');
  });

  it('alarms when history is fresh but the rollout falls behind the lag ceiling', () => {
    const verdict = evaluateCodexRolloutPersistence(
      { ...base, rolloutMtimeMs: NOW - 17 * 60_000 },
      NOW,
    );
    expect(verdict.stalled).toBe(true);
    expect(verdict.reason).toContain('behind history.jsonl');
  });

  it('does not alarm for an idle session, a dead process, or a fresh rollout', () => {
    expect(evaluateCodexRolloutPersistence({ ...base, historyMtimeMs: NOW - 6 * 60_000 }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, pidAlive: false, rolloutMtimeMs: null }, NOW).stalled).toBe(false);
    expect(evaluateCodexRolloutPersistence({ ...base, rolloutMtimeMs: NOW - 2 * 60_000 }, NOW).stalled).toBe(false);
  });
});

function providerErrorLine(turn: string, code = 'usageLimitExceeded', message = 'provider failed'): string {
  return JSON.stringify({
    timestamp: `2026-08-27T00:00:0${turn}Z`,
    type: 'event_msg',
    payload: { type: 'error', codex_error_info: code, message, turn_id: turn },
  });
}

function providerTaskCompleteLine(turn: string, code = 'usageLimitExceeded', message = 'provider failed'): string {
  return JSON.stringify({
    timestamp: `2026-08-27T00:00:1${turn}Z`,
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      status: 'error',
      turn_id: turn,
      error: { codex_error_info: code, message },
    },
  });
}

describe('native Codex provider-error recurrence', () => {
  it('classifies usage-limit and nested unauthorized records with bounded evidence', () => {
    const message = 'Your access token could not be refreshed because you have since logged out or signed in to another account.';
    const error = classifyCodexProviderError(providerTaskCompleteLine('t-1', 'unauthorized', message));
    expect(error).toMatchObject({
      source: 'event_msg:task_complete',
      code: 'unauthorized',
      rawCode: 'unauthorized',
      message,
      turnKey: 't-1',
    });
    expect(classifyCodexProviderError('{not-json')).toBeNull();
    expect(classifyCodexProviderError(JSON.stringify({ type: 'response_item', payload: { type: 'error' } }))).toBeNull();
  });

  it('counts an error/task_complete pair as one failed turn and trips the threshold', () => {
    const lines = [
      providerErrorLine('t-1', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-1', 'usageLimitExceeded'),
      providerErrorLine('t-2', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-2', 'usageLimitExceeded'),
      providerErrorLine('t-3', 'usageLimitExceeded'),
      providerTaskCompleteLine('t-3', 'usageLimitExceeded'),
    ];
    const recurrence = evaluateCodexProviderFailureRecurrence(lines);
    expect(recurrence).toMatchObject({ consecutiveFailures: 3, threshold: 3, dead: true });
    expect(recurrence.failures).toHaveLength(3);
    expect(recurrence.latest?.source).toBe('event_msg:task_complete');
  });

  it('resets the trailing streak after a successful terminal and parses a bounded tail', () => {
    const success = JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', status: 'completed' } });
    const recurrence = scanCodexProviderFailureTail(
      [providerErrorLine('old-1'), providerTaskCompleteLine('old-1'), success, providerErrorLine('new-1')].join('\n'),
      { consecutiveFailures: 2 },
    );
    expect(recurrence).toMatchObject({ consecutiveFailures: 1, threshold: 2, dead: false });
    expect(recurrence.latest?.turnKey).toBe('new-1');
  });

  it('classifies recovery without making the provider observer a lifecycle killer', () => {
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-1', 'server_overloaded'))!)).toBe('backoff');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-2', 'unauthorized'))!)).toBe('park');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-3', 'usageLimitExceeded'))!)).toBe('park');
    expect(providerFailureDisposition(classifyCodexProviderError(providerTaskCompleteLine('t-4', 'context_window_exceeded', 'prompt too long'))!)).toBe('carry_recovery');
  });
});

describe('readCodexRolloutTail', () => {
  it('reads only the requested suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-tail-'));
    const path = join(root, 'rollout.jsonl');
    try {
      await writeFile(path, '0123456789', 'utf8');
      await expect(readCodexRolloutTail(path, 4)).resolves.toBe('6789');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('checkCodexRolloutPersistence provider preservation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    lifecycleMocks.endSession.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('deduplicates the provider escalation while preserving the session and owner surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-runtime-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-42', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, 'rollout-2026-08-27T00-00-00-session-42.jsonl');
    await writeFile(join(root, 'session-42', 'history.jsonl'), '{}\n', 'utf8');
    await writeFile(
      rolloutPath,
      [
        providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
        providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
        providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
      ].join('\n') + '\n',
      'utf8',
    );
    const queries: string[] = [];
    const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join('');
      queries.push(query);
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
        return [{ id: 42, owner_id: 'owner-42', pid: 123, workspace_id: 'workspace-1' }];
      }
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) {
        return [{ phase: 'codex-provider-failure:42' }];
      }
      return [];
    }) as unknown;

    try {
      const result = await checkCodexRolloutPersistence(sql as never, { pidAlive: () => true });
      expect(result.providerFailureSessionIds).toEqual(['42']);
      expect(result.providerAlarmed).toEqual(['42']);
      expect(result.providerPreservedSessionIds).toEqual(['42']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(result.providerCleanupFailed).toEqual([]);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelInboxWake).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelClaimable).not.toHaveBeenCalled();
      expect(lifecycleMocks.retireLifecycleWatches).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
      expect(lifecycleMocks.notifyAttention).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith('[codex-rollout-watchdog] PROVIDER ALARM: owner-42 (session 42)');
      expect(queries.filter((query) => query.includes('INSERT INTO harness_shared.harness_escalations'))).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects repeated provider failures for an open PID-less psu/carry-respawn session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-pidless-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-44', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-2026-08-27T00-00-00-session-44.jsonl'),
      [
        providerTaskCompleteLine('t-1', 'internal_server_error', 'high demand'),
        providerTaskCompleteLine('t-2', 'internal_server_error', 'high demand'),
        providerTaskCompleteLine('t-3', 'internal_server_error', 'high demand'),
      ].join('\n') + '\n',
      'utf8',
    );
    const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
      const query = strings.join('');
      if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
        return [{ id: 44, owner_id: 'owner-44', pid: null, workspace_id: 'workspace-1' }];
      }
      if (query.includes('INSERT INTO harness_shared.harness_escalations')) {
        return [{ phase: 'codex-provider-failure:44' }];
      }
      return [];
    }) as unknown;

    try {
      const result = await checkCodexRolloutPersistence(sql as never, {
        pidAlive: () => {
          throw new Error('a NULL pid must not be probed');
        },
      });
      expect(result.providerFailureSessionIds).toEqual(['44']);
      expect(result.providerAlarmed).toEqual(['44']);
      expect(result.providerPreservedSessionIds).toEqual(['44']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never invokes lifecycle cleanup even when provider failures recur', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-watchdog-end-failure-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = root;
    const day = join(root, 'session-43', 'sessions', '2026', '08', '27');
    await mkdir(day, { recursive: true });
    const rolloutPath = join(day, 'rollout-2026-08-27T00-00-00-session-43.jsonl');
    await writeFile(
      rolloutPath,
      [
        providerErrorLine('t-1'), providerTaskCompleteLine('t-1'),
        providerErrorLine('t-2'), providerTaskCompleteLine('t-2'),
        providerErrorLine('t-3'), providerTaskCompleteLine('t-3'),
      ].join('\n') + '\n',
      'utf8',
    );
    try {
      const result = await checkCodexRolloutPersistence((async (strings: TemplateStringsArray): Promise<unknown[]> => {
        const query = strings.join('');
        if (query.includes('SELECT id, coord_owner_id AS owner_id')) {
          return [{ id: 43, owner_id: 'owner-43', pid: 124, workspace_id: 'workspace-1' }];
        }
        return [];
      }) as never, { pidAlive: () => true });
      expect(result.providerFailureSessionIds).toEqual(['43']);
      expect(result.providerPreservedSessionIds).toEqual(['43']);
      expect(result.providerEndedSessionIds).toEqual([]);
      expect(lifecycleMocks.endSession).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelInboxWake).not.toHaveBeenCalled();
      expect(lifecycleMocks.cancelClaimable).not.toHaveBeenCalled();
      expect(lifecycleMocks.retireLifecycleWatches).not.toHaveBeenCalled();
      expect(lifecycleMocks.releaseWorkItems).not.toHaveBeenCalled();
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
