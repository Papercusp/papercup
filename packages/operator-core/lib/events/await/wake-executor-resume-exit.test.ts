import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultIsHeadlessResumeTurn,
  executeWake,
  isHeadlessResumeArgv,
  ledgerSafeResumeArgv,
  type ExecuteWakeDeps,
  type HeadlessResumeTurnInput,
} from './wake-executor';
import type { ResumeTurnExitRaw } from './resume-turn-outcome';
import type { DeliveryWork, WakeOutcome } from './types';
import { MultiSessionTestbed, makeDelivery, advSessionHandle, deadPid } from '../../../test/_multi-session-testbed';

/**
 * P0a wiring: executeWake's `resume-headless` channel must forward the detached turn's
 * eventual exit to `deps.onResumeTurnExit`, bound to THIS delivery — the seam the loop
 * turn-outcome handler uses to feed the autoloop circuit on a 429 turn-death. The
 * delivery is still 'delivered' the instant a PID lands (the observation is async).
 */
describe('wake-executor — resume-headless exit observation (P0a)', () => {
  let tb: MultiSessionTestbed;
  beforeEach(() => {
    tb = MultiSessionTestbed.create();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await tb.destroy();
  });

  async function exitedClaudeResumeDeps(over: Partial<ExecuteWakeDeps> = {}): Promise<{
    deps: ExecuteWakeDeps;
    s: ReturnType<MultiSessionTestbed['session']>;
  }> {
    const s = tb.session('A');
    const dead = await deadPid();
    return {
      s,
      deps: {
        findPsuHost: () => null, // no live socket → fall through to the resume ladder
        getSession: async () =>
          ({
            pid: dead,
            endedAt: null,
            agent: 'claude',
            sessionId: 'native-A',
            coordOwnerId: null,
            cwd: s.cwd,
          }) as never,
        findPty: () => null,
        write: () => true,
        presence: async () => null,
        alive: () => false,
        // Hermetic Channel 2 resume path: the production default performs the
        // atomic DB claim, but this unit test only exercises detached-exit wiring.
        claimResume: async () => true,
        // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
        accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
        // The resume leg's harness fallback reads the live loop row. That blocked
        // real-PG attempt ran in every test here; model "no loop row" instead.
        getLoopStatusFn: (async () => null) as never,
        ...over,
      },
    };
  }

  it('forwards the detached turn exit to onResumeTurnExit, bound to the delivery; still delivers on spawn', async () => {
    let observed: { d: DeliveryWork; exit: ResumeTurnExitRaw } | null = null;
    let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
    const synthetic: ResumeTurnExitRaw = { exitCode: 1, signal: null, stdoutTail: 'API Error: 429 · Rate limited', stderrTail: '' };

    const { deps, s } = await exitedClaudeResumeDeps({
      // Capture the onExit the executor passes; pretend a pid spawned.
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitWired = onExit;
        return 4242;
      },
      onResumeTurnExit: (d, exit) => {
        observed = { d, exit };
      },
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);

    // Delivered on spawn — the observation does NOT block the delivery.
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    // The executor wired an onExit closure into the spawn.
    expect(onExitWired).toBeTypeOf('function');
    // Firing it (as the real subprocess close would) reaches onResumeTurnExit with THIS delivery.
    onExitWired!(synthetic);
    expect(observed).not.toBeNull();
    expect(observed!.d.id).toBe(d.id);
    expect(observed!.d.subscriberId).toBe(s.ownerId);
    expect(observed!.exit).toEqual(synthetic);
  });

  it('restores transcript tool references in the resumed MCP seed and forwards poison disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const missing = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' }] },
      }));
      vi.stubEnv('PAPERCUSP_TOOLS', 'tools:find,coord:orient');
      const spawnedEnvs: Record<string, string>[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      let observedContext: unknown;
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        quarantineToolReferenceSession: quarantine as never,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        spawnDetached: (_bin, _args, opts, onExit) => {
          spawnedEnvs.push(opts.env);
          onExitWired = onExit;
          return 4242;
        },
        onResumeTurnExit: (_d, _exit, context) => { observedContext = context; },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({
        subscriberId: s.ownerId,
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
      expect(spawnedEnvs[0]?.PAPERCUSP_TOOLS).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit');
      onExitWired!({ exitCode: 1, signal: null, stdoutTail: missing, stderrTail: '' });
      await vi.waitFor(() => expect(observedContext).toMatchObject({ poisoned: true, advSessionId: s.advSessionId }));
      expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
        transcriptPath,
        ownerId: s.ownerId,
        sessionId: 'native-A',
      }), missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drops queued wakes for the exact poisoned adv-session incarnation', async () => {
    let spawned = false;
    const { deps, s } = await exitedClaudeResumeDeps();
    deps.getSessionLifecycle = async () => ({
        poisoned: {
          advSessionId: s.advSessionId,
          sessionId: 'native-A',
          startedAt: '2026-09-24T10:00:00.123Z',
          at: '2026-09-24T10:05:00.000Z',
          by: 'resume-turn-detector',
          reason: 'three consecutive unavailable tool references',
          evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
        },
      });
    deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
    deps.spawnDetached = () => { spawned = true; return 4242; };
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    await expect(executeWake(d, deps)).resolves.toMatchObject({
      kind: 'drop',
      reason: expect.stringContaining('quarantined'),
    });
    expect(spawned).toBe(false);
  });

  it('does not let an old poison marker block a newer resumed incarnation', async () => {
    let spawned = false;
    const { deps, s } = await exitedClaudeResumeDeps({
      collectSessionFiles: async () => [],
      spawnDetached: () => { spawned = true; return 4242; },
    });
    deps.getSessionLifecycle = async () => ({
      poisoned: {
        advSessionId: s.advSessionId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        at: '2026-09-24T10:05:00.000Z',
        by: 'resume-turn-detector',
        reason: 'three consecutive unavailable tool references',
        evidence: "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools",
      },
    });
    deps.getSession = async () => ({
      id: s.advSessionId,
      workspaceId: 'row-ws',
      agent: 'claude',
      coordOwnerId: null,
      sessionId: 'native-A',
      startedAt: '2026-09-24T10:06:00.000Z',
      endedAt: null,
      pid: await deadPid(),
      cwd: s.cwd,
    }) as never;
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawned).toBe(true);
  });

  it('quarantines a live interactive session before the next pty injection after three errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const error = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      const turn = () => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: error }] } });
      writeFileSync(transcriptPath, [turn(), turn(), turn()].join('\n'));
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        alive: () => true,
        quarantineToolReferenceSession: quarantine as never,
        sendCoordMessage: vi.fn(async () => ({} as never)),
        spawnDetached: () => { throw new Error('poisoned live session must not spawn'); },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: 7777,
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });

      await expect(executeWake(d, deps)).resolves.toMatchObject({ kind: 'drop', reason: expect.stringContaining('quarantined') });
      expect(quarantine).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds transcript tool references into a headless resume and quarantines a repeated failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wake-resume-tool-reference-'));
    try {
      const transcriptPath = join(root, 'native-A.jsonl');
      const missing = "API Error: 400 Tool reference 'mcp__papercusp-su__plans_audit' not found in available tools";
      writeFileSync(transcriptPath, JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' }] },
      }));
      vi.stubEnv('PAPERCUSP_TOOLS', 'tools:find,coord:orient');
      const spawnedEnvs: Record<string, string>[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      let observedContext: unknown;
      const quarantine = vi.fn(async () => ({ poisoned: true, turns: 3 }));
      const { deps, s } = await exitedClaudeResumeDeps({
        getSessionLifecycle: async () => null,
        collectSessionFiles: async () => [{
          rel: 'projects/-repo/native-A.jsonl',
          abs: transcriptPath,
          bytes: 1,
          mtimeMs: 1,
        }],
        spawnDetached: (_bin, _args, opts, onExit) => {
          spawnedEnvs.push(opts.env);
          onExitWired = onExit;
          return 4242;
        },
        quarantineToolReferenceSession: quarantine as never,
        onResumeTurnExit: (_d, _exit, context) => { observedContext = context; },
      });
      deps.getSession = async () => ({
        id: s.advSessionId,
        workspaceId: 'row-ws',
        harnessSlug: 'papercusp',
        agent: 'claude',
        coordOwnerId: s.ownerId,
        sessionId: 'native-A',
        startedAt: '2026-09-24T10:00:00.123Z',
        endedAt: null,
        pid: await deadPid(),
        cwd: s.cwd,
      }) as never;
      const d = makeDelivery({
        subscriberId: s.ownerId,
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
      expect(spawnedEnvs[0]?.PAPERCUSP_TOOLS).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit');
      onExitWired!({ exitCode: 1, signal: null, stdoutTail: missing, stderrTail: '' });
      await vi.waitFor(() => expect(observedContext).toMatchObject({ poisoned: true, advSessionId: s.advSessionId }));
      expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({
        transcriptPath,
        ownerId: s.ownerId,
        sessionId: 'native-A',
      }), missing);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('back-compat: with NO onResumeTurnExit dep, the spawn receives an undefined onExit and still delivers', async () => {
    let onExitArg: unknown = 'unset';
    const { deps, s } = await exitedClaudeResumeDeps({
      spawnDetached: (_bin, _args, _o, onExit) => {
        onExitArg = onExit;
        return 4242;
      },
      // no onResumeTurnExit
    });
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });

    const out = await executeWake(d, deps);
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(onExitArg).toBeUndefined();
  });

  // ── WI-10002854: one live process per session ───────────────────────────
  describe('split-brain fence (WI-10002854)', () => {
    it('accounts the spawned turn (ledger + adv pid, row workspace) and reports delivered only after the pid write', async () => {
      const inputs: HeadlessResumeTurnInput[] = [];
      let releasePidWrite!: () => void;
      const pidWrite = new Promise<void>((r) => {
        releasePidWrite = r;
      });
      const { deps, s } = await exitedClaudeResumeDeps({
        getSession: async () =>
          ({
            pid: await deadPid(),
            endedAt: null,
            agent: 'claude',
            sessionId: 'native-A',
            // null keeps the claude rematerialize leg (a PG read) out of this
            // unit test. The ledger owner then falls back to the subscriber.
            coordOwnerId: null,
            cwd: s.cwd,
            workspaceId: 'row-ws',
          }) as never,
        spawnDetached: () => 4242,
        accountHeadlessResumeTurn: (input) => {
          inputs.push(input);
          return { pidRecorded: pidWrite, finish: () => {} };
        },
      });
      const d = makeDelivery({
        subscriberId: s.ownerId,
        workspaceId: 'coord-ws',
        wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }),
      });

      let settled = false;
      const pending = executeWake(d, deps).then((out) => {
        settled = true;
        return out;
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(settled).toBe(false); // delivered is NOT reported before the pid write
      releasePidWrite();
      expect(await pending).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        pid: 4242,
        advSessionId: s.advSessionId,
        sessionWorkspaceId: 'row-ws', // the ROW's workspace, not the coord plane's
        coordOwnerId: s.ownerId,
        agent: 'claude',
        resumeId: 'native-A',
      });
      // The ledger argv never carries the wake text verbatim.
      expect(inputs[0]!.argv.some((a) => a.startsWith('<wake-text '))).toBe(true);
    });

    it('closes the ledger row on exit AND still forwards the exit to onResumeTurnExit', async () => {
      const finished: ResumeTurnExitRaw[] = [];
      const forwarded: ResumeTurnExitRaw[] = [];
      let onExitWired: ((e: ResumeTurnExitRaw) => void) | undefined;
      const { deps, s } = await exitedClaudeResumeDeps({
        spawnDetached: (_b, _a, _o, onExit) => {
          onExitWired = onExit;
          return 4242;
        },
        accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: (e) => finished.push(e) }),
        onResumeTurnExit: (_d, e) => forwarded.push(e),
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });
      await executeWake(d, deps);
      const exit: ResumeTurnExitRaw = { exitCode: 0, signal: null, stdoutTail: '', stderrTail: '' };
      onExitWired!(exit);
      expect(finished).toEqual([exit]);
      expect(forwarded).toEqual([exit]);
    });

    it('a failed spawn accounts nothing', async () => {
      let accounted = 0;
      const { deps, s } = await exitedClaudeResumeDeps({
        spawnDetached: () => null,
        accountHeadlessResumeTurn: () => {
          accounted++;
          return { pidRecorded: Promise.resolve(), finish: () => {} };
        },
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 0 }) });
      expect(await executeWake(d, deps)).toEqual<WakeOutcome>({ kind: 'error', error: 'headless resume spawn failed' });
      expect(accounted).toBe(0);
    });

    /** A live recorded pid for a loop-armed owner: without the fence this reaches
     *  WI-666's force-resume leg, which SIGINTs the pid. */
    async function liveLoopOwnerDeps(isHeadless: boolean) {
      const forced: number[] = [];
      const spawned: string[][] = [];
      const oracleCalls: Array<[number, string | null]> = [];
      const { deps, s } = await exitedClaudeResumeDeps({
        getSession: async () =>
          ({ pid: 7777, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => true,
        isLoopArmed: async () => true,
        forceResume: async (pid) => {
          forced.push(pid);
          return false;
        },
        isHeadlessResumeTurn: (pid, id) => {
          oracleCalls.push([pid, id]);
          return isHeadless;
        },
        spawnDetached: (_b, args) => {
          spawned.push(args);
          return 4242;
        },
      });
      const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: 7777 }) });
      return { out: await executeWake(d, deps), forced, spawned, oracleCalls };
    }

    it('parks (never SIGINTs, never double-resumes) while the recorded pid is a live headless turn of this session', async () => {
      const { out, forced, spawned, oracleCalls } = await liveLoopOwnerDeps(true);
      expect(out.kind).toBe('park');
      expect((out as { reason: string }).reason).toMatch(/headless resume turn pid 7777 is still running/);
      expect(oracleCalls).toEqual([[7777, 'native-A']]);
      expect(forced).toEqual([]);
      expect(spawned).toEqual([]);
    });

    it('control: the same live pid that is NOT a headless turn still reaches the WI-666 force leg', async () => {
      const { out, forced } = await liveLoopOwnerDeps(false);
      expect(forced).toEqual([7777]);
      expect(out.kind).toBe('park');
      expect((out as { reason: string }).reason).toMatch(/bounded force-resume/);
    });
  });
});

describe('isHeadlessResumeArgv / ledgerSafeResumeArgv (WI-10002854)', () => {
  it('matches every resume shape resumeCommandFor emits, only for the exact session id', () => {
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1', '-p', 'go'], 'sid-1')).toBe(true);
    expect(isHeadlessResumeArgv(['claude', '-p', '--resume', 'sid-1'], 'sid-1')).toBe(true);
    expect(isHeadlessResumeArgv(['omp', '-r', 'th-1', '--approval-mode', 'yolo', '-p', 'go'], 'th-1')).toBe(true);
    expect(isHeadlessResumeArgv(['codex', 'exec', 'resume', 'uuid-1', 'go'], 'uuid-1')).toBe(true);
    // An interactive (non -p) process on the session is not a headless turn.
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1'], 'sid-1')).toBe(false);
    // Another session's headless turn does not match, nor does a substring.
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-2', '-p'], 'sid-1')).toBe(false);
    expect(isHeadlessResumeArgv(['claude', '--resume=sid-1x', '-p'], 'sid-1')).toBe(false);
    expect(isHeadlessResumeArgv(['claude', '--resume', 'sid-1', '-p'], '')).toBe(false);
  });

  it('never stores the account-route token or the wake text on the ledger row', () => {
    const settings = JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'sk-secret-123' } });
    const out = ledgerSafeResumeArgv(
      'claude',
      ['--settings', settings, '--settings={"x":"sk-secret-123"}', '--resume', 'sid-1', '-p', 'WAKE TEXT'],
      'WAKE TEXT',
    );
    expect(JSON.stringify(out)).not.toContain('sk-secret-123');
    expect(JSON.stringify(out)).not.toContain('WAKE TEXT');
    expect(out).toEqual([
      'claude',
      '--settings',
      '<redacted>',
      '--settings=<redacted>',
      '--resume',
      'sid-1',
      '-p',
      '<wake-text 9 chars>',
    ]);
  });
});

describe.skipIf(!existsSync('/proc/self/cmdline'))('defaultIsHeadlessResumeTurn — real /proc (WI-10002854)', () => {
  async function withChild(extra: string[], fn: (pid: number) => void): Promise<void> {
    // `--` stops node's own option parsing, so the resume-shaped tokens land
    // verbatim in /proc/<pid>/cmdline, the same as a real `claude -p` turn.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', ...extra], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 100));
      fn(child.pid!);
    } finally {
      child.kill('SIGKILL');
    }
  }

  it('reads the live argv: a headless turn of THIS session is recognised; others are not', async () => {
    await withChild(['--resume', 'sid-proc-1', '-p'], (pid) => {
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-1')).toBe(true);
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-2')).toBe(false);
      expect(defaultIsHeadlessResumeTurn(pid, null)).toBe(false);
    });
    await withChild(['--resume', 'sid-proc-1'], (pid) => {
      expect(defaultIsHeadlessResumeTurn(pid, 'sid-proc-1')).toBe(false);
    });
  });

  it('a dead pid answers false (the existing ladder decides)', async () => {
    expect(defaultIsHeadlessResumeTurn(await deadPid(), 'sid-proc-1')).toBe(false);
  });
});
