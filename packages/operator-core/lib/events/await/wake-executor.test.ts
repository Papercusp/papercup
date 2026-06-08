/**
 * wake-executor.test.ts — the liveness ladder, pure (injected deps, no PG)
 * (await-event-primitive-2026-06-05 P-006, D-003/D-009).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHomeForAdvSession,
  executeWake,
  findCodexRolloutSessionId,
  resumeCommandFor,
  wakeTurnText,
  type ExecuteWakeDeps,
} from './wake-executor';
import { PtyError } from '../../pty-bridge';
import type { DeliveryWork, WakeHandle } from './types';

// A per-session codex home (session-42) with two rollouts; the newer UUID wins.
const ROLLOUT_UUID = '019ea541-e6ed-71c2-bc67-aa25b5164ec5';
let CODEX_HOMES_DIR = '';
let prevCodexHomesEnv: string | undefined;

beforeAll(() => {
  CODEX_HOMES_DIR = mkdtempSync(join(tmpdir(), 'wake-codex-'));
  const sessionsDir = join(CODEX_HOMES_DIR, 'session-42', 'sessions', '2026', '06', '07');
  mkdirSync(sessionsDir, { recursive: true });
  const oldRollout = join(sessionsDir, 'rollout-2026-06-07T10-00-00-00000000-0000-0000-0000-000000000000.jsonl');
  const newRollout = join(sessionsDir, `rollout-2026-06-07T23-23-40-${ROLLOUT_UUID}.jsonl`);
  writeFileSync(oldRollout, '{}');
  writeFileSync(newRollout, '{}');
  utimesSync(oldRollout, new Date('2026-06-01'), new Date('2026-06-01'));
  utimesSync(newRollout, new Date('2026-06-07'), new Date('2026-06-07'));
  prevCodexHomesEnv = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = CODEX_HOMES_DIR;
});

afterAll(() => {
  if (prevCodexHomesEnv === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
  else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = prevCodexHomesEnv;
  try {
    rmSync(CODEX_HOMES_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function work(overrides: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 7,
    workspaceId: 'ws',
    awaitId: 3,
    subscriberId: 'su-abc',
    eventKey: 'lock:grant:t-1',
    payload: null,
    summary: 'your lock on foo.ts was granted',
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    wakeHandle: null,
    note: 'waiting to edit foo.ts',
    ...overrides,
  };
}

const advHandle = (over: Partial<Extract<WakeHandle, { kind: 'adv-session' }>> = {}): WakeHandle => ({
  kind: 'adv-session',
  advSessionId: 42,
  agent: 'claude',
  sessionId: '11111111-2222-3333-4444-555555555555',
  ompThreadId: null,
  cwd: '/repo',
  pid: 9999,
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: 42,
  workspaceId: 'ws',
  planSlug: null,
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console' as const,
  terminalBin: null,
  pid: 9999,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/repo',
  coordOwnerId: 'su-abc',
  sessionId: '11111111-2222-3333-4444-555555555555',
  startedAt: new Date().toISOString(),
  endedAt: null,
  exitCode: null,
  ...over,
});

const livePresence = { stale: false, revoked: false } as never;
const stalePresence = { stale: true, revoked: false } as never;

function deps(over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
  return {
    getSession: vi.fn(async () => session()) as never,
    findPty: vi.fn(() => null) as never,
    write: vi.fn(() => true) as never,
    spawnManagedPty: vi.fn(() => ({ id: 'pty-1' })) as never,
    spawnDetached: vi.fn(() => 1234),
    presence: vi.fn(async () => livePresence) as never,
    alive: vi.fn(() => true),
    resumePlanRun: vi.fn(async () => ({ ok: true as const })),
    ...over,
  };
}

describe('wakeTurnText', () => {
  it('carries the key, summary, note and a bounded payload on one line', () => {
    const t = wakeTurnText(work({ payload: { x: 'y'.repeat(1000) } }));
    expect(t).toContain('lock:grant:t-1');
    expect(t).toContain('your lock on foo.ts was granted');
    expect(t).toContain('waiting to edit foo.ts');
    expect(t).not.toContain('\n');
    expect(t.length).toBeLessThan(700);
  });

  it('marks a timeout wake loudly', () => {
    const t = wakeTurnText(work({ payload: { timeout: true } }));
    expect(t).toContain('TIMEOUT');
    expect(t).toContain('did NOT fire');
  });
});

describe('resumeCommandFor', () => {
  it('claude: exact-session resume with the prompt as positional arg', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    expect(r).not.toBeNull();
    expect(r!.bin).toBe('claude');
    expect(r!.args).toContain('--resume');
    expect(r!.args).toContain('sid-1');
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
    expect(r!.promptViaPty).toBe(false);
  });

  it('claude WITHOUT a native session id is NOT resumable (no --continue on a shared cwd)', () => {
    expect(resumeCommandFor({ agent: 'claude', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('claude tracked-hive resume remounts the persistent signed MCP config (D-010 resume leg)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'session-mcp-'));
    const prev = process.env.PAPERCUSP_SESSION_MCP_DIR;
    process.env.PAPERCUSP_SESSION_MCP_DIR = root;
    try {
      mkdirSync(join(root, 's-123-queen'), { recursive: true });
      writeFileSync(join(root, 's-123-queen', '.mcp.json'), '{"mcpServers":{}}');

      const r = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-123-queen' },
        'WAKE',
      );
      expect(r!.args).toContain('--mcp-config');
      expect(r!.args).toContain(join(root, 's-123-queen', '.mcp.json'));
      expect(r!.args).toContain('--strict-mcp-config');
      // Prompt stays the trailing positional arg.
      expect(r!.args[r!.args.length - 1]).toBe('WAKE');

      // No config on disk for this owner → resume still works, just no remount.
      const bare = resumeCommandFor(
        { agent: 'claude', sessionId: 'sid-q', ompThreadId: null, coordOwnerId: 's-nope' },
        'WAKE',
      );
      expect(bare!.args).not.toContain('--mcp-config');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_SESSION_MCP_DIR;
      else process.env.PAPERCUSP_SESSION_MCP_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('omp: thread resume, prompt rides the pty', () => {
    const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
    expect(r!.bin).toBe('omp');
    expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo']);
    expect(r!.promptViaPty).toBe(true);
  });

  it('codex: headless `exec resume <uuid> <prompt>` when the conversation id is known', () => {
    const r = resumeCommandFor({ agent: 'codex', sessionId: ROLLOUT_UUID, ompThreadId: null }, 'WAKE');
    expect(r!.bin).toBe('codex');
    expect(r!.args).toEqual([
      'exec',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
      'resume',
      ROLLOUT_UUID,
      'WAKE',
    ]);
    expect(r!.promptViaPty).toBe(false);
  });

  it('codex: null without a conversation id (executeWake recovers it; null → park)', () => {
    expect(resumeCommandFor({ agent: 'codex', sessionId: null, ompThreadId: null }, 'WAKE')).toBeNull();
  });

  it('unknown client: null', () => {
    expect(resumeCommandFor({ agent: null, sessionId: 'sid', ompThreadId: null }, 'WAKE')).toBeNull();
  });
});

describe('executeWake — the liveness ladder', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('no handle + live presence → park (inbox-only reachability)', async () => {
    const out = await executeWake(work({ wakeHandle: null }), deps());
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('no handle + stale presence → drop, visibly (dead waiter)', async () => {
    const out = await executeWake(work({ wakeHandle: null }), deps({ presence: vi.fn(async () => stalePresence) as never }));
    expect(out).toMatchObject({ kind: 'drop' });
    expect((out as { reason: string }).reason).toContain('dead waiter');
  });

  it('plan-run handle → resumed via the plans:resume path', async () => {
    const resumePlanRun = vi.fn(async () => ({ ok: true as const }));
    const out = await executeWake(
      work({ wakeHandle: { kind: 'plan-run', runId: 12 } }),
      deps({ resumePlanRun }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'plan-run-resume' });
    expect(resumePlanRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 12 }));
    const planArg = (resumePlanRun.mock.calls[0] as unknown as [{ wakeText: string }])[0];
    expect(planArg.wakeText).toContain('lock:grant:t-1');
  });

  it('alive + managed pty pid-match → inject the wake turn', async () => {
    const write = vi.fn(() => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ findPty: vi.fn(() => ({ id: 'pty-7' })) as never, write: write as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
    const [id, buf] = write.mock.calls[0] as unknown as [string, Buffer];
    expect(id).toBe('pty-7');
    expect(buf.toString()).toMatch(/\r$/);
    expect(buf.toString()).toContain('lock:grant:t-1');
  });

  it('alive in a terminal we do not own → park (never inject keystrokes elsewhere)', async () => {
    const out = await executeWake(work({ wakeHandle: advHandle() }), deps());
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('alive');
  });

  it('exited claude with a native id → DETACHED headless `-p` turn (never a pty — a TTY stdin makes `-p` hang)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnManagedPty = vi.fn(() => ({ id: 'pty-new' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), spawnDetached, spawnManagedPty: spawnManagedPty as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    // claude resume runs detached, NOT in the pty (the Stage-B hang fix).
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('claude');
    expect(args).toContain('--resume');
    expect(args).toContain('-p'); // headless one-turn
    expect(o.cwd).toBe('/repo');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
  });

  it('exited codex → DETACHED `exec resume <uuid>` with CODEX_HOME, uuid recovered from the rollout (P-009)', async () => {
    const spawnDetached = vi.fn(() => 5555);
    const out = await executeWake(
      // codex carries no native id on the row — executeWake recovers it from the home.
      work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null })) as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('codex');
    expect(args.slice(0, 4)).toEqual([
      'exec', '--dangerously-bypass-hook-trust', '--dangerously-bypass-approvals-and-sandbox', 'resume',
    ]);
    expect(args[4]).toBe(ROLLOUT_UUID); // recovered from the newest rollout
    expect(args[5]).toContain('lock:grant:t-1'); // the wake turn text
    expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
  });

  it('exited codex with NO recoverable home → park, never a bare --last (P-009)', async () => {
    const out = await executeWake(
      // adv-session 999 has no codex home on disk → no uuid → not resumable.
      work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null, advSessionId: 999 }) }),
      deps({
        alive: vi.fn(() => false),
        getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, id: 999 })) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
  });

  it('a session row marked ended is exited even if the recorded pid is reused-alive', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => session({ endedAt: new Date().toISOString() })) as never,
        alive: vi.fn(() => true), // pid reused by some other process
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('exited claude WITHOUT a native id + live presence → park, never --continue', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ sessionId: null }) }),
      deps({
        getSession: vi.fn(async () => session({ sessionId: null })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
  });

  it('exited omp → resume + the prompt injected into the new pty after the TUI settles', async () => {
    const write = vi.fn(() => true);
    const spawnManagedPty = vi.fn(() => ({ id: 'pty-omp' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
        write: write as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume' });
    expect(write).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(write).toHaveBeenCalled();
    expect((write.mock.calls[0] as unknown as [string, Buffer])[0]).toBe('pty-omp');
  });

  it('NO recorded pid + fresh presence → park (never concurrent-resume a live session)', async () => {
    const spawnManagedPty = vi.fn(() => ({ id: 'x' }));
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        spawnManagedPty: spawnManagedPty as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
  });

  it('NO recorded pid + stale presence → resume (the session is gone)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle({ pid: null }) }),
      deps({
        getSession: vi.fn(async () => session({ pid: null })) as never,
        presence: vi.fn(async () => stalePresence) as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('claude resume spawn failure (detached returns no pid) → error outcome (the pump retries with backoff)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        alive: vi.fn(() => false),
        spawnDetached: vi.fn(() => null) as never,
      }),
    );
    expect(out).toMatchObject({ kind: 'error' });
  });
});

describe('codex home + rollout recovery (P-009/P-010)', () => {
  it('codexHomeForAdvSession keys the home by the adv-session id', () => {
    expect(codexHomeForAdvSession(42)).toBe(join(CODEX_HOMES_DIR, 'session-42'));
  });

  it('findCodexRolloutSessionId returns the NEWEST rollout uuid; null when absent', () => {
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-42'))).toBe(ROLLOUT_UUID);
    expect(findCodexRolloutSessionId(join(CODEX_HOMES_DIR, 'session-nope'))).toBeNull();
  });
});
