/**
 * chat-spawn-tracking.test.ts — EI-259: agent-chat runs get durable nursery
 * rows (record → heartbeat → finish) with best-effort semantics (a tracking
 * failure never breaks the chat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  beginChatSpawnTracking,
  resolveChatRunOutcome,
} from './chat-spawn-tracking';
import { SPAWN_HEARTBEAT_INTERVAL_MS } from './spawn-reclaim';
import type { Db } from './pg-stores';

/** A fake `postgres` tag that records every query and resolves to []. */
function fakeSql() {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('¿'), values });
    return Promise.resolve([]);
  };
  return { sql: tag as unknown as Db, queries };
}

const BASE = {
  chatId: 'chat-1',
  workspaceId: 'ws-test',
  harnessSlug: 'h-test',
  childRole: 'worker',
  runId: 'run-1',
  featureId: 'F-1',
} as const;

describe('resolveChatRunOutcome', () => {
  it('clean completion → done', () => {
    expect(resolveChatRunOutcome({
      sawDone: true, toolErrorMessage: null, lastErrorMessage: null, threwMessage: null, aborted: false,
    })).toEqual({ status: 'done', errorMessage: null });
  });

  it('tool-level error → failed with its message', () => {
    expect(resolveChatRunOutcome({
      sawDone: false, toolErrorMessage: 'boom', lastErrorMessage: null, threwMessage: null, aborted: false,
    })).toEqual({ status: 'failed', errorMessage: 'boom' });
  });

  it('in-band error event → failed', () => {
    expect(resolveChatRunOutcome({
      sawDone: true, toolErrorMessage: null, lastErrorMessage: 'agent died', threwMessage: null, aborted: false,
    })).toEqual({ status: 'failed', errorMessage: 'agent died' });
  });

  it('thrown dispatch → failed; thrown while aborted → cancelled (throw wins over tool error)', () => {
    expect(resolveChatRunOutcome({
      sawDone: false, toolErrorMessage: 'tool', lastErrorMessage: null, threwMessage: 'ECONNRESET', aborted: false,
    })).toEqual({ status: 'failed', errorMessage: 'ECONNRESET' });
    expect(resolveChatRunOutcome({
      sawDone: false, toolErrorMessage: null, lastErrorMessage: null, threwMessage: 'aborted', aborted: true,
    }).status).toBe('cancelled');
  });

  it('stream ended without done → cancelled when client aborted, else failed', () => {
    expect(resolveChatRunOutcome({
      sawDone: false, toolErrorMessage: null, lastErrorMessage: null, threwMessage: null, aborted: true,
    })).toEqual({ status: 'cancelled', errorMessage: 'client disconnected before completion' });
    expect(resolveChatRunOutcome({
      sawDone: false, toolErrorMessage: null, lastErrorMessage: null, threwMessage: null, aborted: false,
    })).toEqual({ status: 'failed', errorMessage: 'stream ended without a completion event' });
  });
});

describe('beginChatSpawnTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PAPERCUSP_LOCK_DOMAIN;
  });

  it('records a per-turn running row: agent_chats-<chatId>- spawn id, chat role, run id, sessionOwner = spawnId', async () => {
    const { sql, queries } = fakeSql();
    const handle = await beginChatSpawnTracking({ ...BASE, sql });
    expect(handle).not.toBeNull();
    expect(handle!.spawnId).toMatch(/^agent_chats-chat-1-[0-9a-f]{8}$/);

    expect(queries).toHaveLength(1);
    const insert = queries[0];
    expect(insert.text).toContain('INSERT INTO harness_shared.spawned_agents');
    expect(insert.values).toContain(handle!.spawnId);
    expect(insert.values).toContain('ws-test');
    expect(insert.values).toContain('h-test');
    expect(insert.values).toContain('worker');
    expect(insert.values).toContain('run-1');
    expect(insert.values).toContain('F-1');
    expect(insert.values).toContain('running');
    // sessionOwner = spawnId (the fleet:cancel transitive-release link)
    expect(insert.values.filter((v) => v === handle!.spawnId).length).toBeGreaterThanOrEqual(2);
    await handle!.finish({ status: 'done' });
  });

  it('two turns of the same chat get DISTINCT spawn ids (one row per invocation)', async () => {
    const { sql } = fakeSql();
    const a = await beginChatSpawnTracking({ ...BASE, sql });
    const b = await beginChatSpawnTracking({ ...BASE, sql });
    expect(a!.spawnId).not.toBe(b!.spawnId);
    await a!.finish({ status: 'done' });
    await b!.finish({ status: 'done' });
  });

  it('threads the projectDir lock domain into the row (PAPERCUSP_LOCK_DOMAIN override path)', async () => {
    process.env.PAPERCUSP_LOCK_DOMAIN = 'test-domain';
    const { sql, queries } = fakeSql();
    const handle = await beginChatSpawnTracking({ ...BASE, projectDir: '/tmp/proj-x', sql });
    expect(queries[0].values).toContain('test-domain');
    await handle!.finish({ status: 'done' });
  });

  it('heartbeats on the reclaim cadence while running; finish stops the beat', async () => {
    const { sql, queries } = fakeSql();
    const handle = await beginChatSpawnTracking({ ...BASE, sql });
    queries.length = 0;

    await vi.advanceTimersByTimeAsync(SPAWN_HEARTBEAT_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(SPAWN_HEARTBEAT_INTERVAL_MS);
    const beats = queries.filter((q) => q.text.includes('heartbeat_at'));
    expect(beats).toHaveLength(2);
    expect(beats[0].values).toEqual([[handle!.spawnId]]);

    await handle!.finish({ status: 'done' });
    queries.length = 0;
    await vi.advanceTimersByTimeAsync(SPAWN_HEARTBEAT_INTERVAL_MS * 3);
    expect(queries.filter((q) => q.text.includes('heartbeat_at'))).toHaveLength(0);
  });

  it('finish flips the row terminal with status/error/output tail, and is idempotent', async () => {
    const { sql, queries } = fakeSql();
    const handle = await beginChatSpawnTracking({ ...BASE, sql });
    queries.length = 0;

    await handle!.finish({ status: 'failed', errorMessage: 'boom', outputTail: 'tail-text' });
    const finishes = queries.filter((q) => q.text.includes('finished_at'));
    expect(finishes).toHaveLength(1);
    expect(finishes[0].values).toContain('failed');
    expect(finishes[0].values).toContain('boom');
    expect(finishes[0].values).toContain('tail-text');

    await handle!.finish({ status: 'done' });
    expect(queries.filter((q) => q.text.includes('finished_at'))).toHaveLength(1);
  });

  it('returns null (chat streams untracked) when the insert fails — never throws', async () => {
    const sql = (() => Promise.reject(new Error('pg down'))) as unknown as Db;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(beginChatSpawnTracking({ ...BASE, sql })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('finish swallows a PG failure (best-effort) — the reclaim sweep is the backstop', async () => {
    let calls = 0;
    const flaky = (() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve([]) // the INSERT succeeds
        : Promise.reject(new Error('pg down')); // everything after fails
    }) as unknown as Db;
    const handle = await beginChatSpawnTracking({ ...BASE, sql: flaky });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(handle!.finish({ status: 'done' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
