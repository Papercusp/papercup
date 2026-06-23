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
  injectOmpWakeTurnWhenReady,
  hiveInstallSlugFromLabel,
  ompResumePtyLooksReady,
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
    source: null,
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

function fakeOmpPty(id = 'pty-omp') {
  return {
    id,
    onData: new Set<(chunk: Buffer) => void>(),
    onExit: new Set<(code: number, signal: number) => void>(),
    history: [] as Buffer[],
    killed: false,
    exitCode: null as number | null,
  };
}

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
    // Hermetic by default: no live psu-pty host (don't read the real ~/.papercusp).
    findPsuHost: vi.fn(() => null) as never,
    injectPsuHost: vi.fn(async () => true) as never,
    // Hermetic by default: the hive-fresh-wake fire is stubbed so a hive-labelled
    // session never reaches the real default (which lazy-imports + touches PG).
    fireHiveWake: vi.fn(async () => true) as never,
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

  // GAP 1 (likely bug): a timeout-fire payload `{timeout:true}` coalesced with a
  // sibling has its headline payload replaced by `{coalesced,count,events,latest}`
  // (coalesceDeliveries) — the top-level `timeout` marker is GONE. wakeTurnText
  // must still surface [TIMEOUT] by looking inside the union, or the woken agent is
  // told the event FIRED when it actually TIMED OUT.
  it('coalesced timeout wake STILL emits [TIMEOUT] (GAP 1: the marker survives coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The newest (headline) delivery is the timeout fire; an earlier sibling is a
    // normal event fire — exactly the engine.ts sweeper + pump interleaving.
    const sibling = work({ id: 30, eventKey: 'lock:grant:t-1', payload: null, createdAt: new Date(1000).toISOString() });
    const timeoutHeadline = work({
      id: 31,
      eventKey: 'plan-run:finished:9',
      payload: { timeout: true },
      summary: 'await deadline passed without the event firing',
      createdAt: new Date(2000).toISOString(),
    });
    const coalesced = coalesceDeliveries([sibling, timeoutHeadline]);
    // The headline payload IS the union now — proves the raw `.timeout` is buried.
    expect((coalesced.payload as { coalesced?: boolean }).coalesced).toBe(true);
    expect((coalesced.payload as { timeout?: boolean }).timeout).toBeUndefined();
    // ...yet the wake turn still warns the agent the event TIMED OUT.
    const t = wakeTurnText(coalesced);
    expect(t).toMatch(/TIMEOUT/);
    expect(t).toContain('did NOT fire');
  });

  it('coalesced timeout in a FOLDED sibling (not the headline) also surfaces [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // The timeout is the OLDER fire; the newest is a normal event → the marker
    // lives only in `events[]`, not in `latest`. Still must surface.
    const timeoutSibling = work({ id: 40, payload: { timeout: true }, createdAt: new Date(1000).toISOString() });
    const eventHeadline = work({ id: 41, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([timeoutSibling, eventHeadline]));
    expect(t).toMatch(/TIMEOUT/);
  });

  it('a coalesced group with NO timeout does not emit a spurious [TIMEOUT]', async () => {
    const { coalesceDeliveries } = await import('./engine');
    const a = work({ id: 50, payload: { ok: true }, createdAt: new Date(1000).toISOString() });
    const b = work({ id: 51, payload: { ok: true }, createdAt: new Date(2000).toISOString() });
    const t = wakeTurnText(coalesceDeliveries([a, b]));
    expect(t).not.toContain('TIMEOUT');
  });

  it('single-delivery timeout path still works (no coalescing)', async () => {
    const { coalesceDeliveries } = await import('./engine');
    // group.length === 1 → coalesceDeliveries returns the headline unchanged, so
    // the plain `{timeout:true}` path is untouched by the GAP 1 fix.
    const single = coalesceDeliveries([work({ id: 60, payload: { timeout: true } })]);
    expect((single.payload as { timeout?: boolean }).timeout).toBe(true);
    expect(wakeTurnText(single)).toMatch(/TIMEOUT/);
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

  it('claude: re-arms the native-scheduler lockout on every wake as ONE `=` token before the positional prompt', () => {
    const r = resumeCommandFor({ agent: 'claude', sessionId: 'sid-1', ompThreadId: null }, 'WAKE');
    const denyIdx = r!.args.findIndex((a) => a.startsWith('--disallowedTools='));
    expect(denyIdx).toBeGreaterThan(-1);
    // The single-token form is load-bearing: the variadic space form would
    // consume the trailing wake text as deny rules (D-002,
    // native-scheduler-lockout-2026-06-09).
    expect(r!.args[denyIdx]).toContain('ScheduleWakeup');
    expect(r!.args[denyIdx]).toContain('CronCreate');
    expect(/\s/.test(r!.args[denyIdx])).toBe(false);
    expect(denyIdx).toBeLessThan(r!.args.length - 1); // wake text still trails
    expect(r!.args[r!.args.length - 1]).toBe('WAKE');
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

  it('omp: thread resume defaults to headless one-turn with the wake prompt', () => {
    const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
    expect(r!.bin).toBe('omp');
    expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo', '-p', 'WAKE']);
    expect(r!.promptViaPty).toBe(false);
  });

  it('omp: can fall back to PTY injection for older builds', () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    try {
      const r = resumeCommandFor({ agent: 'omp', sessionId: null, ompThreadId: 'th-9' }, 'WAKE');
      expect(r!.bin).toBe('omp');
      expect(r!.args).toEqual(['-r', 'th-9', '--approval-mode', 'yolo']);
      expect(r!.promptViaPty).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp readiness detector recognizes prompt-like resume screens', () => {
    expect(ompResumePtyLooksReady('OMP ready\n> ')).toBe(true);
    expect(ompResumePtyLooksReady('Type a message to continue')).toBe(true);
    expect(ompResumePtyLooksReady('booting provider adapters...')).toBe(false);
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

  it('no handle BUT a live psu-host socket → inject via the socket, not park (EI-152)', async () => {
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: injectPsuHost as never }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(injectPsuHost).toHaveBeenCalledWith('/tmp/x.sock', expect.objectContaining({ mode: 'turn' }));
  });

  it('no handle + live socket but inject FAILS → falls through to park (live presence)', async () => {
    const out = await executeWake(
      work({ wakeHandle: null }),
      deps({ findPsuHost: vi.fn(() => ({ sock: '/tmp/x.sock' })) as never, injectPsuHost: vi.fn(async () => false) as never }),
    );
    expect(out).toMatchObject({ kind: 'park' });
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

  it('alive + managed pty pid-match → inject the turn TEXT now, the submit CR as a SEPARATE keystroke', async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn(() => true);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({ findPty: vi.fn(() => ({ id: 'pty-7' })) as never, write: write as never }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'pty-inject' });
      // First write = the turn TEXT, with NO trailing CR. A one-shot text+CR burst
      // is swallowed by the claude TUI's paste detector (CR → literal newline), so
      // the CR must arrive as its own keystroke.
      const [id, buf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(id).toBe('pty-7');
      expect(buf.toString()).toContain('lock:grant:t-1');
      expect(buf.toString()).not.toMatch(/\r$/);
      expect(write).toHaveBeenCalledTimes(1);
      // The submit CR lands as a SEPARATE write after the settle delay.
      await vi.advanceTimersByTimeAsync(200);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
    } finally {
      vi.useRealTimers();
    }
  });

  it('alive in a terminal we do not own → park (never inject keystrokes elsewhere)', async () => {
    const out = await executeWake(work({ wakeHandle: advHandle() }), deps());
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('alive');
  });

  it('live psu-pty host → inject the wake turn into its control socket (channel psu-socket-inject)', async () => {
    // turn-lifecycle-control Phase 3 P-014: a live interactive psu session the
    // operator can't see via findPty (its pty is in the psu process) is woken in
    // place via its discovered control socket — NOT parked, NOT a concurrent resume.
    const injectPsuHost = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/su-abc.sock' })) as never,
        injectPsuHost: injectPsuHost as never,
        // even if findPty would match, the psu host is checked FIRST (it's the
        // authoritative live-injectable signal).
        findPty: vi.fn(() => ({ id: 'pty-7' })) as never,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'psu-socket-inject' });
    const [sock, msg] = injectPsuHost.mock.calls[0] as unknown as [string, { mode: string; data: string }];
    expect(sock).toBe('/tmp/psu-pty/su-abc.sock');
    expect(msg.mode).toBe('turn');
    expect(msg.data).toContain('lock:grant:t-1');
  });

  it('psu host present but the socket inject FAILS → falls through to the normal channels (park)', async () => {
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        findPsuHost: vi.fn(() => ({ sock: '/tmp/psu-pty/dead.sock' })) as never,
        injectPsuHost: vi.fn(async () => false) as never, // socket died mid-attempt
      }),
    );
    // findPty defaults to null + alive → "alive but not an injectable managed pty" park.
    expect(out).toMatchObject({ kind: 'park' });
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

  it('exited omp → detached headless one-turn resume with prompt (no PTY)', async () => {
    const spawnDetached = vi.fn(() => 2468);
    const spawnManagedPty = vi.fn(() => fakeOmpPty());
    const out = await executeWake(
      work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
      deps({
        getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
        alive: vi.fn(() => false),
        spawnManagedPty: spawnManagedPty as never,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnManagedPty).not.toHaveBeenCalled();
    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string, string[], { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('omp');
    expect(args.slice(0, 4)).toEqual(['-r', 'th-1', '--approval-mode', 'yolo']);
    expect(args).toContain('-p');
    expect(args[args.length - 1]).toContain('lock:grant:t-1');
    expect(o.env.PAPERCUSP_SID).toBe('su-abc');
  });

  it('exited omp PTY fallback → readiness-gated prompt injection into the new pty', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const spawnManagedPty = vi.fn(() => pty);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: spawnManagedPty as never,
          write: write as never,
        }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).not.toHaveBeenCalled();
      for (const cb of pty.onData) cb(Buffer.from('OMP ready\n> '));
      // Audit P-034: the prompt must land as TWO writes — text, then the submit
      // CR as a separate keystroke after a settle. The old single text+CR buffer
      // tripped the TUI paste detector (CR → literal newline, turn never submits).
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(1);
      const [ptyId, textBuf] = write.mock.calls[0] as unknown as [string, Buffer];
      expect(ptyId).toBe('pty-omp');
      expect(textBuf.toString()).not.toMatch(/\r$/);
      await vi.advanceTimersByTimeAsync(400);
      expect(write).toHaveBeenCalledTimes(2);
      expect((write.mock.calls[1] as unknown as [string, Buffer])[1].toString()).toBe('\r');
      await expect(pending).resolves.toEqual({ kind: 'delivered', channel: 'resume' });
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('exited omp PTY fallback readiness timeout → error with transcript tail and pty cleanup', async () => {
    const prev = process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
    process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = '1';
    const write = vi.fn(() => true);
    const pty = fakeOmpPty();
    const kill = vi.fn(() => true);
    try {
      const pending = executeWake(
        work({ wakeHandle: advHandle({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' }) }),
        deps({
          getSession: vi.fn(async () => session({ agent: 'omp', sessionId: null, ompThreadId: 'th-1' })) as never,
          alive: vi.fn(() => false),
          spawnManagedPty: vi.fn(() => pty) as never,
          write: write as never,
          kill: kill as never,
        }),
      );
      for (const cb of pty.onData) cb(Buffer.from('loading account router'));
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(pending).resolves.toMatchObject({
        kind: 'error',
        error: expect.stringContaining('did not become ready'),
      });
      expect(write).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith('pty-omp');
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_OMP_RESUME_VIA_PTY;
      else process.env.PAPERCUSP_OMP_RESUME_VIA_PTY = prev;
    }
  });

  it('omp prompt helper accepts a quiet settled screen and captures transcript tail', async () => {
    const write = vi.fn(() => true);
    const pty = fakeOmpPty('pty-helper');
    const pending = injectOmpWakeTurnWhenReady({
      pty,
      wakeText: 'WAKE',
      write: write as never,
      readyTimeoutMs: 1_000,
      quietReadyMs: 100,
      submitCrDelayMs: 25,
    });
    for (const cb of pty.onData) cb(Buffer.from('restored thread th-1\n'));
    await vi.advanceTimersByTimeAsync(100);
    expect(write).toHaveBeenCalledWith('pty-helper', Buffer.from('WAKE', 'utf8'));
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ ok: true, transcriptTail: 'restored thread th-1\n' });
    expect(write).toHaveBeenLastCalledWith('pty-helper', Buffer.from('\r', 'utf8'));
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

describe('GAP 3: wake resume env-assembly matrix (wake-executor.ts:441-474)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('claude resume with a coord owner + on-disk config dir → CLAUDE_CONFIG_DIR + MCP_TIMEOUT + PAPERCUSP_AGENT_SESSION + fleet token', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-claude-cfg-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-claude-token-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'claude-token');
    try {
      // The persistent per-session config dir the resume leg remounts (D-010).
      mkdirSync(pjoin(claudeRoot, 'su-owner-9'), { recursive: true });
      // A minted fleet setup-token so CLAUDE_CODE_OAUTH_TOKEN is exported (P-003).
      writeFileSync(pjoin(tokenDir, 'claude-token'), 'sk-ant-oat01-test-token\n');

      const spawnDetached = vi.fn(() => 4321);
      const out = await executeWake(
        work({ wakeHandle: advHandle() }),
        deps({
          alive: vi.fn(() => false), // exited → resume
          getSession: vi.fn(async () => session({ agent: 'claude', coordOwnerId: 'su-owner-9' })) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      // Base wake env (always present on a resume).
      expect(o.env.PAPERCUSP_SID).toBe('su-abc');
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
      expect(o.env.PAPERCUSP_WAKE_DELIVERY_ID).toBe('7');
      // claude-specific: config-dir remount + fleet token.
      expect(o.env.CLAUDE_CONFIG_DIR).toBe(pjoin(claudeRoot, 'su-owner-9'));
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
      // No codex home leaks onto a claude resume.
      expect(o.env.CODEX_HOME).toBeUndefined();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });

  it('codex resume → CODEX_HOME present, but CLAUDE_CONFIG_DIR + CLAUDE_CODE_OAUTH_TOKEN ABSENT (no claude env leaks)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join: pjoin } = await import('node:path');
    // Point the claude config root + token at tmp roots WITHOUT provisioning this
    // owner's subdir/token — so even though coordOwnerId is set, neither claude
    // env is applied (the fleet token is claude-only; CLAUDE_CONFIG_DIR needs the
    // dir on disk). Hermetic: never reads the real ~/.papercusp.
    const claudeRoot = mkdtempSync(pjoin(tmpdir(), 'wake-codex-noclaude-'));
    const tokenDir = mkdtempSync(pjoin(tmpdir(), 'wake-codex-notoken-'));
    const prevCfg = process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
    const prevTok = process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
    process.env.PAPERCUSP_SESSION_CLAUDE_DIR = claudeRoot;
    process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = pjoin(tokenDir, 'absent-token');
    // A claude token exists on disk — proving codex STILL doesn't pick it up.
    writeFileSync(pjoin(tokenDir, 'absent-token'), 'sk-ant-oat01-should-not-be-used\n');
    try {
      const spawnDetached = vi.fn(() => 5555);
      const out = await executeWake(
        // adv-session 42 has a codex home on disk (the suite fixture) → uuid recovered.
        work({ wakeHandle: advHandle({ agent: 'codex', sessionId: null }) }),
        deps({
          alive: vi.fn(() => false),
          // coordOwnerId set to prove it does NOT pull a claude config dir for codex.
          getSession: vi.fn(async () => session({ agent: 'codex', sessionId: null, coordOwnerId: 'su-owner-9' })) as never,
          spawnDetached,
        }),
      );
      expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
      const [bin, , o] = spawnDetached.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(bin).toBe('codex');
      // codex-specific: its per-session home is exported.
      expect(o.env.CODEX_HOME).toBe(join(CODEX_HOMES_DIR, 'session-42'));
      // The claude-only env is NOT applied to a codex resume (the fleet token is a
      // claude-OAuth concept, keyed off `resumeAgent==='claude'`; CLAUDE_CONFIG_DIR
      // needs the owner's dir on disk, which we deliberately did NOT create).
      expect(o.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(o.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      // Base wake env still present.
      expect(o.env.PAPERCUSP_AGENT_SESSION).toBe('1');
      expect(o.env.MCP_TIMEOUT).toBeTruthy();
    } finally {
      if (prevCfg === undefined) delete process.env.PAPERCUSP_SESSION_CLAUDE_DIR;
      else process.env.PAPERCUSP_SESSION_CLAUDE_DIR = prevCfg;
      if (prevTok === undefined) delete process.env.PAPERCUSP_CLAUDE_TOKEN_PATH;
      else process.env.PAPERCUSP_CLAUDE_TOKEN_PATH = prevTok;
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(tokenDir, { recursive: true, force: true });
    }
  });
});

describe('hive Queen fresh-per-wake cutover (queen-brief-cache-assembly B-01 / P-012)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const hiveSession = (over: Record<string, unknown> = {}) =>
    session({ label: 'hive · papercup/queen', ...over });

  it('exited hive operator → FRESH hive launch (never claude --resume), carrying the wake text as kickoff', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false), // turn ended → would otherwise resume
        fireHiveWake,
        spawnDetached,
      }),
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'hive-fresh-wake' });
    // The Queen is fresh-launched, NEVER resumed.
    expect(spawnDetached).not.toHaveBeenCalled();
    const arg = (fireHiveWake.mock.calls[0] as unknown as [{ installSlug: string; kickoff: string }])[0];
    expect(arg.installSlug).toBe('papercup');
    expect(arg.kickoff).toContain('lock:grant:t-1'); // the wake turn text
  });

  it('hive operator + fresh-wake fire FAILS → park, NEVER a --resume fallback (the no-resume invariant is absolute)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({
        getSession: vi.fn(async () => hiveSession()) as never,
        alive: vi.fn(() => false),
        fireHiveWake: vi.fn(async () => false) as never, // fire failed
        spawnDetached,
      }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect((out as { reason: string }).reason).toContain('never resumed');
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('LIVE hive operator (mid-turn, not an injectable pty) → park, no concurrent fresh launch', async () => {
    // Reached BEFORE the resume/fresh-wake branch (the isAlive guard), so a live
    // Queen is never double-launched.
    const fireHiveWake = vi.fn(async () => true);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ getSession: vi.fn(async () => hiveSession()) as never, alive: vi.fn(() => true), fireHiveWake }),
    );
    expect(out).toMatchObject({ kind: 'park' });
    expect(fireHiveWake).not.toHaveBeenCalled();
  });

  it('a NON-hive ended session (no hive label) still resumes — the cutover is scoped to hive operators only', async () => {
    const fireHiveWake = vi.fn(async () => true);
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      work({ wakeHandle: advHandle() }),
      deps({ alive: vi.fn(() => false), fireHiveWake, spawnDetached }), // session() label is null
    );
    expect(out).toEqual({ kind: 'delivered', channel: 'resume-headless' });
    expect(fireHiveWake).not.toHaveBeenCalled();
    expect(spawnDetached).toHaveBeenCalled();
  });
});

describe('hiveInstallSlugFromLabel', () => {
  it('parses the install slug from a hive-operator adv_sessions label', () => {
    expect(hiveInstallSlugFromLabel('hive · papercup/queen')).toBe('papercup');
    expect(hiveInstallSlugFromLabel('hive · my-hive/operator')).toBe('my-hive');
  });
  it('returns null for a non-hive label (so non-hive sessions resume as before)', () => {
    expect(hiveInstallSlugFromLabel(null)).toBeNull();
    expect(hiveInstallSlugFromLabel('')).toBeNull();
    expect(hiveInstallSlugFromLabel('bee · papercup/worker')).toBeNull();
    expect(hiveInstallSlugFromLabel('hive · ')).toBeNull(); // no slug
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
