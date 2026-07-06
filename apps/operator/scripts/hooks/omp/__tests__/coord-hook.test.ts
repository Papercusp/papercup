/**
 * Unit tests for the OMP coord hook's pure helpers — formatting only.
 * The HTTP / handler-registration paths are integration concerns,
 * verified at deploy against a live OMP runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildActivityArgs,
  buildDisplayTitleOsc,
  buildObjectiveTitleOsc,
  callMcpTool,
  emitStatusDisplay,
  statusNoticeKey,
  _resetStatusNoticeDedup,
  resolveHookWorkspace,
  collapseDigestNotifies,
  destructiveGitCommandOp,
  destructiveGitDenyReason,
  detectSymlinkedPaths,
  reportActivity,
  reportLifecycle,
  extractPathsFromToolInput,
  formatBusyRefusal,
  formatInboxDelta,
  formatSymlinkRefusal,
  formatTurnStartReminder,
  isNativeToolSearch,
  extractToolSearchQuery,
  formatToolFindRedirect,
  IDENTICAL_CALL_LOOP_LIMIT,
  toolCallLoopKey,
  noteToolCallRepeat,
  resetToolCallLoopState,
  loopBreakReason,
  sessionRepeatKey,
  SESSION_REPEAT_LIMIT,
  noteSessionRepeat,
  resetSessionRepeatRun,
  sessionRepeatReason,
  SHELL_CALLS_PER_TURN_LIMIT,
  isShellTool,
  noteShellCall,
  shellBudgetReason,
  FLEET_LAUNCH_CALLS_PER_SESSION,
  isFleetLaunchCall,
  resetFleetLaunchBudget,
  fleetLaunchBudgetReason,
  isLocalModel,
  getOwnLaunchedModel,
  fleetLaunchMemberModel,
  fleetLaunchModelReason,
  isClaimNextCall,
  claimNextBlockReason,
  isAgentSession,
  isEvalCall,
  evalBlockReason,
  EVAL_BLOCK_ESCALATE_AFTER,
  noteEvalBlock,
  resetEvalBlockBudget,
  EVAL_BLOCK_KILL_AFTER,
  setHaltForTest,
  isAskCall,
  askBlockReason,
  isIrcCall,
  ircBlockReason,
  isMcpEndpointCurl,
  mcpCurlBlockReason,
  MCP_CURL_BLOCK_ESCALATE_AFTER,
  noteMcpCurlBlock,
  resetMcpCurlBudget,
  MCP_CURL_BLOCK_KILL_AFTER,
  isMcpToolViaBash,
  extractMcpToolViaBash,
  nativeMcpToolName,
  mcpToolViaBashReason,
  MCP_TOOL_VIA_BASH_ESCALATE_AFTER,
  noteMcpToolViaBashBlock,
  resetMcpToolViaBashBudget,
  REFLEXIVE_BLOCK_KILL_AFTER,
  REFLEXIVE_BLOCK_ESCALATE_AFTER,
  noteReflexiveBlock,
  resetReflexiveBlockBudget,
  isTodoCall,
  todoLoopReason,
  TODO_LOOP_LIMIT,
  TODO_LOOP_ESCALATE_AFTER,
  noteTodoCall,
  resetTodoLoopState,
  STALL_WATCHDOG_MS,
  STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS,
  pokeStallWatchdog,
  disarmStallWatchdog,
  noteStallToolInFlight,
  _stallWatchdogArmed,
  hookOwnerId,
  linkAdvSessionFromContext,
  onSessionShutdown,
  onSessionStart,
  onToolCall,
  onToolResult,
  onTurnStart,
  OS_SCHEDULER_CMD_RE,
  pollInboxDelta,
  summarisePlanEvents,
  _resetHookOwnerIdForTests,
  _resetMidTurnCursorForTests,
  _resetToolCallCacheForTests,
  _resetDegradedNotifiedForTests,
  _resetActivityReportDedupeForTests,
  type InboxEntry,
} from '../coord-hook';

// ── native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010) ─────

// hookOwnerId now PREFERS PAPERCUSP_SID; the dev/CI env may carry a real one, which would make the
// minted-`omp-…`-owner assertions throughout this suite see a `su-…` owner instead. Clear it by
// default so the suite runs in the deterministic minted-fallback mode; the single PAPERCUSP_SID-path
// test in the hookOwnerId describe sets it explicitly within its own body.
const _origPaperSidForSuite = process.env.PAPERCUSP_SID;
// isAgentSession() (WI-2350) also treats PAPERCUSP_AGENT==='omp' as an agent
// session. Clear it by default so the "owner session, marker unset" tests
// throughout the suite see isAgentSession()===false; tests that want the omp
// signal set it explicitly within their own body.
const _origPaperAgentForSuite = process.env.PAPERCUSP_AGENT;
beforeEach(() => {
  delete process.env.PAPERCUSP_SID;
  delete process.env.PAPERCUSP_AGENT;
});
afterEach(() => {
  if (_origPaperSidForSuite === undefined) delete process.env.PAPERCUSP_SID;
  else process.env.PAPERCUSP_SID = _origPaperSidForSuite;
  if (_origPaperAgentForSuite === undefined) delete process.env.PAPERCUSP_AGENT;
  else process.env.PAPERCUSP_AGENT = _origPaperAgentForSuite;
});

describe('OS_SCHEDULER_CMD_RE (command-position OS-scheduler match)', () => {
  it('matches schedulers at command position, incl. compound + sudo forms', () => {
    for (const cmd of [
      'crontab -e',
      'crontab',
      'at 10pm -f job.sh',
      'batch < jobs.txt',
      'systemd-run --on-calendar=daily echo hi',
      'cd /tmp && crontab newtab',
      'git status; crontab -l',
      'echo done | at midnight',
      'sudo crontab -u root -e',
      'true\ncrontab -l',
    ]) {
      expect(cmd).toMatch(OS_SCHEDULER_CMD_RE);
    }
  });

  it('never matches prose args, mid-word hits, or lookalike commands', () => {
    for (const cmd of [
      'cat file.txt',
      'atuin search foo',
      'attach session-3',
      'echo "look at this"',
      'git commit -m "fix crontab docs"', // 'crontab' not at command position
      'ls -la',
      'systemctl --user restart papercup-staging-api.service', // systemctl ≠ systemd-run
    ]) {
      expect(cmd).not.toMatch(OS_SCHEDULER_CMD_RE);
    }
  });
});

// ── destructive tree-wide git guard (EI-2376 follow-up (a)) ──────────────────
// TypeScript mirror of the Claude+Codex shell hook's Python guard
// (pretooluse-bash-resource-gate.sh) — see its own bash-resource-gate.test.ts
// for the shell-side coverage of the identical cases.

describe('destructiveGitCommandOp (command-position destructive git match)', () => {
  it.each([
    ['bare reset --hard', 'git reset --hard', 'git reset --hard'],
    ['reset --hard HEAD', 'git reset --hard HEAD', 'git reset --hard'],
    ['reset --hard a remote ref', 'git reset --hard origin/staging', 'git reset --hard'],
    ['clean -f', 'git clean -f', 'git clean -f'],
    ['clean -fd', 'git clean -fd', 'git clean -f'],
    ['clean -fdx', 'git clean -fdx', 'git clean -f'],
    ['checkout .', 'git checkout .', 'git checkout/restore .'],
    ['checkout -- .', 'git checkout -- .', 'git checkout/restore .'],
    ['checkout :/ (repo-root pathspec)', 'git checkout :/', 'git checkout/restore .'],
    ['restore .', 'git restore .', 'git checkout/restore .'],
    ['bare stash', 'git stash', 'git stash'],
    ['stash save', 'git stash save "wip"', 'git stash'],
    ['stash push (no explicit path)', 'git stash push', 'git stash'],
    ['sudo-prefixed reset --hard', 'sudo git reset --hard', 'git reset --hard'],
    ['compound && reset --hard', 'cd /tmp && git reset --hard', 'git reset --hard'],
    ['compound ; clean -f', 'git status ; git clean -f', 'git clean -f'],
    ['newline-separated stash', 'git status\ngit stash', 'git stash'],
    ['git -C <dir> reset --hard', 'git -C /some/repo reset --hard', 'git reset --hard'],
  ])('flags %s', (_label, command, expectedOp) => {
    expect(destructiveGitCommandOp(command)).toBe(expectedOp);
  });

  it.each([
    ['checkout of an explicit single file', 'git checkout -- path/to/file.ts'],
    ['restore of an explicit single file', 'git restore path/to/file.ts'],
    ['stash pop', 'git stash pop'],
    ['stash apply', 'git stash apply'],
    ['stash list', 'git stash list'],
    ['stash show', 'git stash show'],
    ['stash drop', 'git stash drop'],
    ['stash branch', 'git stash branch wip-x'],
    ['stash clear', 'git stash clear'],
    ['stash push with an explicit `--` path', 'git stash push -- path/to/file.ts'],
    ['clean dry-run (no f flag)', 'git clean -n'],
    ['reset (no --hard)', 'git reset HEAD~1'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['ordinary status', 'git status'],
    ['ordinary diff', 'git diff --stat'],
    ['"reset --hard" only in a commit message, not command position', 'git commit -m "docs: explain git reset --hard"'],
    ['"git reset --hard" inside a string arg, not command position', 'echo "git reset --hard"'],
  ])('never flags %s', (_label, command) => {
    expect(destructiveGitCommandOp(command)).toBeNull();
  });
});

describe('destructiveGitDenyReason', () => {
  it('names the op + the single-file escape hatch', () => {
    const reason = destructiveGitDenyReason('git reset --hard');
    expect(reason).toContain('shared-tree guard');
    expect(reason).toContain('git reset --hard');
    expect(reason).toContain('git checkout -- <that.one.file>');
  });
});

describe('onToolCall destructive-git guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('blocks a destructive tree-wide git command when the agent-session marker is set', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-1',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('shared-tree guard');
  });

  it('allows a safe single-file git command in agent sessions', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-2',
      input: { command: 'git checkout -- path/to/file.ts' },
    });
    expect(r.block).toBeUndefined();
  });

  it("never fires for the owner's own sessions (marker unset — D-003 exemption mirrors the scheduler lockout)", async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-3',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBeUndefined();
  });
});

// ── doom-loop breaker (ornith-reliability-2026-07-03 / EI-7076 + EI-7092) ────

describe('toolCallLoopKey (stable, sorted, bounded, never-throws)', () => {
  it('is identical for the same tool + same args regardless of key order', () => {
    const a = toolCallLoopKey('resolve', { action: 'apply', reason: 'go' });
    const b = toolCallLoopKey('resolve', { reason: 'go', action: 'apply' });
    expect(a).toBe(b);
  });
  it('lowercases the tool name (case-insensitive match)', () => {
    expect(toolCallLoopKey('Bash', { command: 'ls' })).toBe(toolCallLoopKey('bash', { command: 'ls' }));
  });
  it('differs when args differ', () => {
    expect(toolCallLoopKey('bash', { command: 'find a' })).not.toBe(
      toolCallLoopKey('bash', { command: 'find b' }),
    );
  });
  it('caps the arg blob so a huge input cannot blow memory', () => {
    const huge = 'x'.repeat(100_000);
    expect(toolCallLoopKey('bash', { command: huge }).length).toBeLessThan(2100);
  });
  it('never throws on an unserializable (circular) input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toolCallLoopKey('resolve', circular)).not.toThrow();
    expect(toolCallLoopKey('resolve', circular)).toContain('unserializable');
  });
  it('treats undefined input as empty (a repeat of no-args still detects)', () => {
    expect(toolCallLoopKey('resolve', undefined)).toBe(toolCallLoopKey('resolve', {}));
  });
});

describe('noteToolCallRepeat + resetToolCallLoopState (consecutive-run counter)', () => {
  beforeEach(() => resetToolCallLoopState());
  it('increments only while the key is unchanged, resets on a new key', () => {
    const k1 = toolCallLoopKey('resolve', { action: 'apply', reason: 'x' });
    expect(noteToolCallRepeat(k1)).toBe(1);
    expect(noteToolCallRepeat(k1)).toBe(2);
    expect(noteToolCallRepeat(k1)).toBe(3);
    const k2 = toolCallLoopKey('read', { path: 'a.ts' });
    expect(noteToolCallRepeat(k2)).toBe(1); // different key → run resets
    expect(noteToolCallRepeat(k1)).toBe(1); // back to k1 is a fresh run (non-consecutive)
  });
  it('resetToolCallLoopState clears the run so the next call is length 1', () => {
    const k = toolCallLoopKey('resolve', {});
    noteToolCallRepeat(k);
    noteToolCallRepeat(k);
    resetToolCallLoopState();
    expect(noteToolCallRepeat(k)).toBe(1);
  });
});

describe('sessionRepeatKey + noteSessionRepeat (session-cumulative repeat breaker #9)', () => {
  beforeEach(() => resetSessionRepeatRun());
  it('ignores the noise `i`/intent field so prose-only tweaks key the same', () => {
    const a = sessionRepeatKey('plans:get', { i: 'read the plan', slug: 's', mode: 'full' });
    const b = sessionRepeatKey('plans:get', { i: 'read the plan WITH harness papercusp', slug: 's', mode: 'full' });
    expect(a).toBe(b); // only `i` differs → same key
  });
  it('still distinguishes calls that differ in a REAL arg', () => {
    const a = sessionRepeatKey('plans:get', { slug: 's', mode: 'full' });
    const b = sessionRepeatKey('plans:get', { slug: 's', mode: 'full', harness: 'papercusp' });
    expect(a).not.toBe(b); // adding the harness arg is a genuinely different call
  });
  it('counts consecutive same-key calls and resets on a genuinely different call', () => {
    const k1 = sessionRepeatKey('plans:get', { slug: 's', mode: 'full' });
    expect(noteSessionRepeat(k1)).toBe(1);
    expect(noteSessionRepeat(k1)).toBe(2);
    const k2 = sessionRepeatKey('read', { path: 'a.ts' });
    expect(noteSessionRepeat(k2)).toBe(1); // different call → run resets
    expect(noteSessionRepeat(k1)).toBe(1); // back to k1 is a fresh run
  });
  it('the reason tells the model to read the error + pass the missing arg as a TOP-LEVEL arg', () => {
    const r = sessionRepeatReason('plans:get', SESSION_REPEAT_LIMIT);
    expect(r).toContain('repeat-breaker');
    expect(r).toContain('harness');
    expect(r).toContain('TOP-LEVEL');
  });
});

describe('onToolCall session-repeat breaker (agent sessions only, SURVIVES turn boundaries — mode #9)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetSessionRepeatRun();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetSessionRepeatRun();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // The iter25 shape: plans:get with a VARYING prose `i`, identical real args, EACH its own turn
  // (resetToolCallLoopState between calls simulates turn_start). The turn-scoped breaker resets every
  // turn; only the session-cumulative breaker catches this.
  const plansGet = (i: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_plans_get',
      toolCallId: `pg${i}`,
      input: { i: `read the plan attempt ${i}`, slug: 'ornith-comprehension-test-2026-07-04', mode: 'full' },
    });

  it('blocks the cross-turn plans:get loop that the turn-scoped breaker misses (harness_required 58×)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
      resetToolCallLoopState(); // a fresh turn each call → the turn-scoped breaker never accumulates
      expect((await plansGet(n)).block).toBeUndefined();
    }
    resetToolCallLoopState();
    const over = await plansGet(SESSION_REPEAT_LIMIT);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('repeat-breaker');
  });

  it('a genuinely different call between repeats RESETS the run (varied work never trips)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
      resetToolCallLoopState();
      expect((await plansGet(n)).block).toBeUndefined();
    }
    // A different tool call resets the session-repeat run…
    resetToolCallLoopState();
    await onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'r', input: { file_path: '/x' } });
    // …so the next plans:get starts a fresh run and is NOT blocked.
    resetToolCallLoopState();
    expect((await plansGet(100)).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 0; n < SESSION_REPEAT_LIMIT + 4; n++) {
      resetToolCallLoopState();
      expect((await plansGet(n)).block).toBeUndefined();
    }
  });

  it('feeds the SHARED reflexive backstop — a pure repeat-loop HALTS (naming repeat)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Warm-up to the limit (allowed), then the blocked calls feed the shared backstop.
      for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
        resetToolCallLoopState();
        await plansGet(n);
      }
      for (let n = 0; n < REFLEXIVE_BLOCK_KILL_AFTER - 1; n++) {
        resetToolCallLoopState();
        expect((await plansGet(1000 + n)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      resetToolCallLoopState();
      expect((await plansGet(2000)).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('repeat');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('loopBreakReason (family-specific steer)', () => {
  it('redirects a resolve loop to plans:get / tools:invoke', () => {
    const r = loopBreakReason('resolve', 3);
    expect(r).toContain('loop-breaker');
    expect(r).toContain('3 times in a row');
    expect(r).toContain('plans:get');
    expect(r).toContain('tools:invoke');
  });
  it('redirects a shell loop to the read/grep/ls tools', () => {
    const r = loopBreakReason('bash', 4);
    expect(r).toMatch(/read|grep|ls/);
    expect(r).toContain('do not loop');
  });
  it('falls back to a generic change-your-approach steer', () => {
    const r = loopBreakReason('read', 3);
    expect(r).toContain('change your approach');
  });
});

describe('onToolCall doom-loop breaker (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const resolveCall = () =>
    onToolCall({
      type: 'tool_call',
      toolName: 'resolve',
      toolCallId: 'r',
      input: { action: 'apply', reason: 'Invoking plans:get to read the plan.' },
    });

  it('blocks the Nth identical resolve call (the EI-7076 leader loop) and passes the first two', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await resolveCall()).block).toBeUndefined(); // #1
    expect((await resolveCall()).block).toBeUndefined(); // #2
    const third = await resolveCall(); // #3 → blocked
    expect(third.block).toBe(true);
    expect(third.reason).toContain('plans:get');
    // and it keeps blocking while the loop continues
    expect((await resolveCall()).block).toBe(true);
  });

  it('blocks an identical bash find-flail (the EI-7092 member loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const findCall = () =>
      onToolCall({
        type: 'tool_call',
        toolName: 'bash',
        toolCallId: 'f',
        input: { command: 'find /repo -name design.tsx' },
      });
    await findCall();
    await findCall();
    const r = await findCall();
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/read|grep|ls/);
  });

  it('does NOT trip when the identical run is interrupted by a different call', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    await resolveCall(); // #1
    await resolveCall(); // #2
    // a different tool resets the consecutive run
    await onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'x', input: { path: 'a.ts' } });
    expect((await resolveCall()).block).toBeUndefined(); // fresh run → #1, not blocked
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let i = 0; i < IDENTICAL_CALL_LOOP_LIMIT + 2; i++) {
      expect((await resolveCall()).block).toBeUndefined();
    }
  });

  it('a specific guard (destructive git) still wins at call #1, before the loop threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'g',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('shared-tree guard'); // git message, not the loop message
  });
});

describe('isAgentSession (guard gating, WI-2350)', () => {
  const prev = { s: process.env.PAPERCUSP_AGENT_SESSION, a: process.env.PAPERCUSP_AGENT };
  afterEach(() => {
    if (prev.s === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prev.s;
    if (prev.a === undefined) delete process.env.PAPERCUSP_AGENT;
    else process.env.PAPERCUSP_AGENT = prev.a;
  });
  it('true when the canonical marker is set', () => {
    delete process.env.PAPERCUSP_AGENT;
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect(isAgentSession()).toBe(true);
  });
  it('true for an omp session even WITHOUT the marker (the run-3b backstop)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'omp';
    expect(isAgentSession()).toBe(true);
  });
  it('false for an owner session — neither signal (D-003)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    delete process.env.PAPERCUSP_AGENT;
    expect(isAgentSession()).toBe(false);
  });
  it('false for a non-omp agent (claude/codex) without the marker', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'claude';
    expect(isAgentSession()).toBe(false);
  });
  it('a guard fires for an omp session with ONLY PAPERCUSP_AGENT set (marker absent — the exact run-3b bug)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'omp';
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    // The eval block (a marker-gated guard) must now trip even though the
    // canonical marker was never set — this is what was inert in run-3b.
    const r = await onToolCall({ type: 'tool_call', toolName: 'eval', toolCallId: 'e', input: { code: 'x' } });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('eval-blocked');
  });
});

describe('isEvalCall + evalBlockReason (eval doom-loop guard, WI-2299)', () => {
  it('matches a raw eval/python code-exec tool in every spelling', () => {
    expect(isEvalCall('eval')).toBe(true);
    expect(isEvalCall('eval_tool')).toBe(true);
    expect(isEvalCall('run_python')).toBe(true);
    expect(isEvalCall('python')).toBe(true);
    expect(isEvalCall('EVAL')).toBe(true); // case-insensitive
    expect(isEvalCall('mcp__ollama_cc:eval')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up legitimately-namespaced verbs or unrelated tools', () => {
    expect(isEvalCall('code:run')).toBe(false); // bare verb `run`, not `runpython`
    expect(isEvalCall('code_run')).toBe(false);
    expect(isEvalCall('plans:get')).toBe(false);
    expect(isEvalCall('bash')).toBe(false);
    expect(isEvalCall('tools:invoke')).toBe(false);
    expect(isEvalCall('evaluate')).toBe(false); // not an exact bare match
    expect(isEvalCall('')).toBe(false);
  });
  it('the reason redirects onto the native tool / tools:invoke / Bash triad', () => {
    const r = evalBlockReason();
    expect(r).toContain('eval-blocked');
    expect(r).toContain('tools:invoke');
    expect(r).toContain('Bash');
    expect(r).toContain('NATIVELY');
  });
  it('escalates to a hard, copy-pasteable directive once the block is ignored past the threshold', () => {
    // At/under the threshold: the polite triad steer (no STOP).
    expect(evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER)).toContain('NATIVELY');
    expect(evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER)).not.toContain('STOP');
    // Past it: a hard STOP naming the run length, with the literal plans:get / tools:invoke next-action.
    const hard = evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('plans:get');
    expect(hard).toContain('tools:invoke');
    expect(hard).toContain(`×${EVAL_BLOCK_ESCALATE_AFTER + 1}`);
  });
  it('noteEvalBlock is session-cumulative and resetEvalBlockBudget clears it', () => {
    resetEvalBlockBudget();
    expect(noteEvalBlock()).toBe(1);
    expect(noteEvalBlock()).toBe(2);
    resetEvalBlockBudget();
    expect(noteEvalBlock()).toBe(1);
  });
});

describe('onToolCall eval guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetEvalBlockBudget();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetEvalBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const evalCall = (code: string) =>
    onToolCall({ type: 'tool_call', toolName: 'eval', toolCallId: 'e', input: { code } });

  it('blocks an eval call on #1 — even with DIFFERENT code each time (non-adjacent runs)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // The consecutive-identical loop-breaker would NEVER catch this (each call differs);
    // the tool-name block must fire on the very first call.
    const first = await evalCall('plans.get(slug="x")');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('eval-blocked');
    const second = await evalCall('plans.get(slug="y")'); // different code
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < EVAL_BLOCK_ESCALATE_AFTER + 2; i++) {
      const r = await evalCall(`attempt_${i}()`); // DIFFERENT code each time — non-adjacent runs
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    // Past the threshold the steer becomes the hard, copy-pasteable STOP directive.
    expect(reason).toContain('STOP');
    expect(reason).toContain('plans:get');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await evalCall('anything')).block).toBeUndefined();
  });

  it('leaves a legitimate namespaced tool (code:run) alone', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'code:run',
      toolCallId: 'c',
      input: { code: 'ok' },
    });
    expect(r.block).toBeUndefined();
  });

  it('structurally HALTS the session after EVAL_BLOCK_KILL_AFTER cumulative blocked evals (iter14 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls 1..K-1 are blocked but must NOT halt yet — prose escalation gets its chance first.
      for (let i = 0; i < EVAL_BLOCK_KILL_AFTER - 1; i++) {
        const r = await evalCall(`attempt_${i}()`); // different code each time — non-adjacent runs
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // Call #K: still blocked AND the structural halt fires exactly once, naming the run length.
      const kth = await evalCall('attempt_final()');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(EVAL_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < EVAL_BLOCK_KILL_AFTER + 3; i++) {
        const r = await evalCall(`owner_${i}()`);
        expect(r.block).toBeUndefined(); // an owner's eval is never even blocked, let alone halted
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isMcpEndpointCurl + mcpCurlBlockReason (MCP-endpoint-curl guard, ornith mode #3 / WI-2382)', () => {
  it('matches an agent curling the MCP endpoint in the shapes a model copies from mcp.json', () => {
    // the exact endpoint path
    expect(isMcpEndpointCurl('curl http://127.0.0.1:9071/api/mcp')).toBe(true);
    // the superuser query param (MCP-only), on any host
    expect(isMcpEndpointCurl('curl "http://localhost:3070/api/mcp?superuser=1&client=x"')).toBe(true);
    // the bundle-server port alone
    expect(isMcpEndpointCurl('curl -s http://127.0.0.1:9071/')).toBe(true);
    // a POST with a bearer + JSON-RPC body, uppercased, still matches on /api/mcp
    expect(
      isMcpEndpointCurl(
        'CURL -X POST http://127.0.0.1:9071/api/mcp -H "Authorization: Bearer PCVq" -d \'{"method":"tools/call"}\'',
      ),
    ).toBe(true);
    // a /mcp path on a local operator port (no /api prefix)
    expect(isMcpEndpointCurl('curl localhost:3170/mcp')).toBe(true);
    // wget / xh / httpie clients, and curl after a shell separator
    expect(isMcpEndpointCurl('wget http://127.0.0.1:9071/api/mcp -O -')).toBe(true);
    expect(isMcpEndpointCurl('cd /tmp && curl http://localhost:9071/api/mcp')).toBe(true);
    expect(isMcpEndpointCurl('xh POST 127.0.0.1:9071/api/mcp')).toBe(true);
  });
  it('ALSO matches the python/node HTTP-client evasion (iter24: curl blocked → python urllib)', () => {
    // The exact iter24 shape: python3 -c "import urllib.request; …Request('…/api/mcp?superuser=1')"
    expect(
      isMcpEndpointCurl(
        `python3 -c "import json, urllib.request; urllib.request.Request('http://localhost:3070/api/mcp?superuser=1', data=b'{}')"`,
      ),
    ).toBe(true);
    // requests, httpx, node fetch, aiohttp — any scripting client hitting the MCP endpoint
    expect(isMcpEndpointCurl(`python3 -c "import requests; requests.post('http://127.0.0.1:9071/api/mcp', json={})"`)).toBe(true);
    expect(isMcpEndpointCurl(`python3 -c "import httpx; httpx.post('http://localhost:3070/mcp')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "fetch('http://localhost:3070/api/mcp?superuser=1')"`)).toBe(true);
  });
  it('ALSO matches the Node built-in http module evasion (iter28: fetch/curl blocked → require("http"))', () => {
    // The exact iter28 shape: node -e "const http = require('http'); http.request(…/api/mcp…)"
    expect(
      isMcpEndpointCurl(
        `cd /repo && node -e "const http = require('http'); const req = http.request('http://127.0.0.1:9071/api/mcp', {method:'POST'})"`,
      ),
    ).toBe(true);
    // https module + .get(, double-quoted require, and the node: scheme form
    expect(isMcpEndpointCurl(`node -e "const https=require(\\"https\\"); https.request('http://localhost:3070/api/mcp?superuser=1')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "require('node:http').get('http://127.0.0.1:9071/api/mcp')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "http.get('http://localhost:3170/mcp')"`)).toBe(true);
  });
  it('a scripting HTTP client to a NON-MCP target is still not matched (marker still required)', () => {
    expect(isMcpEndpointCurl(`python3 -c "import requests; requests.get('https://api.github.com')"`)).toBe(false);
    expect(
      isMcpEndpointCurl(`python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:3070/api/health')"`),
    ).toBe(false);
    // Node http module to a NON-MCP local route (health check) — client present, no marker → not matched
    expect(isMcpEndpointCurl(`node -e "require('http').get('http://127.0.0.1:3070/api/health')"`)).toBe(false);
  });
  it('does NOT match a legitimate external curl or a non-MCP local API probe', () => {
    expect(isMcpEndpointCurl('curl https://api.github.com/repos/x/y')).toBe(false);
    expect(isMcpEndpointCurl('curl -s https://example.com/mcp-docs')).toBe(false); // remote host, mcp-docs not a /mcp path
    expect(isMcpEndpointCurl('curl http://127.0.0.1:3070/api/health')).toBe(false); // operator health, not MCP
    expect(isMcpEndpointCurl('echo "see http://127.0.0.1:9071/api/mcp for the endpoint"')).toBe(false); // no client verb
    expect(isMcpEndpointCurl('git commit -m "wire /api/mcp curl helper"')).toBe(false); // curl is prose, not a client verb
    expect(isMcpEndpointCurl('')).toBe(false);
    expect(isMcpEndpointCurl('ls -la')).toBe(false);
  });
  it('the reason tells the model the tools are TOOLS, not an HTTP endpoint (the live-validated rescue)', () => {
    const r = mcpCurlBlockReason();
    expect(r).toContain('mcp-curl-blocked');
    expect(r).toContain('TOOLS you call directly');
    expect(r).toContain('tools:invoke');
    expect(r).toContain('plans:get');
  });
  it('escalates to a hard, copy-pasteable directive once the block is ignored past the threshold', () => {
    // At/under the threshold: the polite redirect (no STOP).
    expect(mcpCurlBlockReason(MCP_CURL_BLOCK_ESCALATE_AFTER)).not.toContain('STOP');
    // Past it: a hard STOP naming the run length, with the literal tools:invoke next-action.
    const hard = mcpCurlBlockReason(MCP_CURL_BLOCK_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('tools:invoke');
    expect(hard).toContain(`×${MCP_CURL_BLOCK_ESCALATE_AFTER + 1}`);
  });
  it('noteMcpCurlBlock is session-cumulative and resetMcpCurlBudget clears it', () => {
    resetMcpCurlBudget();
    expect(noteMcpCurlBlock()).toBe(1);
    expect(noteMcpCurlBlock()).toBe(2);
    resetMcpCurlBudget();
    expect(noteMcpCurlBlock()).toBe(1);
  });
});

describe('onToolCall MCP-endpoint-curl guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetMcpCurlBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetMcpCurlBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const curlCall = (command: string) =>
    onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'mc', input: { command } });

  it('blocks a curl-the-MCP-endpoint bash command on #1 — even with a DIFFERENT body each time (non-adjacent runs)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // The consecutive-identical loop-breaker would never catch this (each JSON body differs);
    // the command-content block must fire on the very first call.
    const first = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"name":"plans:get"}\'');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('mcp-curl-blocked');
    const second = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"name":"coord:orient"}\'');
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < MCP_CURL_BLOCK_ESCALATE_AFTER + 2; i++) {
      const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"attempt":${i}}'`); // different body each time
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    expect(reason).toContain('STOP');
    expect(reason).toContain('tools:invoke');
  });

  it('leaves a legitimate non-MCP bash command alone (operator health probe)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await curlCall('curl -s http://127.0.0.1:3070/api/health');
    expect(r.block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await curlCall('curl http://127.0.0.1:9071/api/mcp');
    expect(r.block).toBeUndefined();
  });

  it('structurally HALTS the session after MCP_CURL_BLOCK_KILL_AFTER cumulative blocked curls (mode #3 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls 1..K-1 are blocked but must NOT halt yet — prose escalation gets its chance first.
      for (let i = 0; i < MCP_CURL_BLOCK_KILL_AFTER - 1; i++) {
        const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"i":${i}}'`); // different body each time
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // Call #K: still blocked AND the structural halt fires exactly once, naming the run length.
      const kth = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"i":"final"}\'');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(MCP_CURL_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < MCP_CURL_BLOCK_KILL_AFTER + 3; i++) {
        const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"i":${i}}'`);
        expect(r.block).toBeUndefined(); // an owner's curl is never even blocked, let alone halted
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isMcpToolViaBash + mcpToolViaBashReason (MCP-tool-via-bash guard, ornith mode #7 / WI-2382)', () => {
  it('matches a papercusp group:verb typed as a shell command (with or without args, after a separator)', () => {
    expect(isMcpToolViaBash('fleet:launch-on-plan')).toBe(true);
    expect(isMcpToolViaBash('fleet:launch-on-plan --count 2')).toBe(true);
    expect(isMcpToolViaBash('plans:get {slug:"x", harness:"papercusp"}')).toBe(true);
    expect(isMcpToolViaBash('tools:invoke {name:"fleet:launch-on-plan"}')).toBe(true);
    expect(isMcpToolViaBash('coord:send')).toBe(true);
    expect(isMcpToolViaBash('work_items:list')).toBe(true);
    expect(isMcpToolViaBash('memory:remember')).toBe(true);
    expect(isMcpToolViaBash('pot:status')).toBe(true); // post pot-rename cutover (was 'hive'; hive:* now 404)
    expect(isMcpToolViaBash('cd /tmp && plans:get')).toBe(true); // command position after &&
  });
  it('does NOT false-positive on ordinary shell commands or a colon that is not a tool name', () => {
    expect(isMcpToolViaBash('curl http://127.0.0.1:9071/api/mcp')).toBe(false); // URL, not group:verb at cmd pos
    expect(isMcpToolViaBash("sed 's:a:b:g' file")).toBe(false); // sed is the command; colon is not a tool
    expect(isMcpToolViaBash('echo fleet:launch-on-plan')).toBe(false); // merely echoing, not invoking
    expect(isMcpToolViaBash('git log --oneline')).toBe(false);
    expect(isMcpToolViaBash('time: 5')).toBe(false); // group not a known MCP group
    expect(isMcpToolViaBash('note:todo fix later')).toBe(false);
    expect(isMcpToolViaBash('ls -la')).toBe(false);
    expect(isMcpToolViaBash('')).toBe(false);
  });
  it('the reason says call it as a DIRECT tool (not bash) and escalates to a hard STOP', () => {
    const base = mcpToolViaBashReason();
    expect(base).toContain('mcp-tool-via-bash');
    expect(base).toContain('tools:invoke');
    expect(base).toContain('fleet:launch-on-plan');
    expect(base).not.toContain('STOP —');
    const hard = mcpToolViaBashReason(MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain(`×${MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1}`);
  });
  it('names the EXACT native tool name when the group:verb is known (iter32→33 fix)', () => {
    // both branches (soft + escalated) must carry the native-name hint
    const soft = mcpToolViaBashReason(1, 'plans:get');
    expect(soft).toContain('mcp__papercusp_su_plans_get');
    expect(soft).toContain('plans:get');
    const hard = mcpToolViaBashReason(MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1, 'fleet:launch-on-plan');
    expect(hard).toContain('mcp__papercusp_su_fleet_launch_on_plan');
    // without a group:verb the hint is absent (no dangling `mcp__` text)
    expect(mcpToolViaBashReason(1)).not.toContain('mcp__papercusp_su_');
  });
  it('noteMcpToolViaBashBlock is session-cumulative and resetMcpToolViaBashBudget clears it', () => {
    resetMcpToolViaBashBudget();
    expect(noteMcpToolViaBashBlock()).toBe(1);
    expect(noteMcpToolViaBashBlock()).toBe(2);
    resetMcpToolViaBashBudget();
    expect(noteMcpToolViaBashBlock()).toBe(1);
  });
});

describe('extractMcpToolViaBash + nativeMcpToolName (native-tool-name bridge, WI-2382 iter32→33)', () => {
  it('extract returns the normalized group:verb for a known MCP group typed as bash', () => {
    expect(extractMcpToolViaBash('plans:get {slug:"x"}')).toBe('plans:get');
    expect(extractMcpToolViaBash('cd /tmp && fleet:launch-on-plan --count 2')).toBe('fleet:launch-on-plan');
    expect(extractMcpToolViaBash('WORK_ITEMS:CLAIM')).toBe('work_items:claim'); // normalized to lowercase
  });
  it('extract returns null for non-tool colons and unknown groups (parity with isMcpToolViaBash)', () => {
    expect(extractMcpToolViaBash("sed 's:a:b:g' file")).toBeNull();
    expect(extractMcpToolViaBash('time: 5')).toBeNull(); // not a known MCP group
    expect(extractMcpToolViaBash('echo plans:get')).toBeNull(); // not at command position
    expect(extractMcpToolViaBash('ls -la')).toBeNull();
    // isMcpToolViaBash is exactly (extract !== null)
    expect(isMcpToolViaBash('plans:get')).toBe(extractMcpToolViaBash('plans:get') !== null);
    expect(isMcpToolViaBash('time: 5')).toBe(extractMcpToolViaBash('time: 5') !== null);
  });
  it('nativeMcpToolName flattens group:verb (colon + hyphens → underscores) to the omp-exposed name', () => {
    expect(nativeMcpToolName('plans:get')).toBe('mcp__papercusp_su_plans_get');
    expect(nativeMcpToolName('plans:set-status')).toBe('mcp__papercusp_su_plans_set_status');
    expect(nativeMcpToolName('fleet:launch-on-plan')).toBe('mcp__papercusp_su_fleet_launch_on_plan');
    expect(nativeMcpToolName('work_items:claim')).toBe('mcp__papercusp_su_work_items_claim');
    expect(nativeMcpToolName('TOOLS:FIND')).toBe('mcp__papercusp_su_tools_find'); // case-normalized
  });
});

describe('onToolCall MCP-tool-via-bash guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetMcpToolViaBashBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetMcpToolViaBashBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const bashCall = (command: string) =>
    onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'mb', input: { command } });

  it('blocks fleet:launch-on-plan typed as bash on #1 — even with DIFFERENT args each time (the iter21 loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const first = await bashCall('fleet:launch-on-plan --count 2 --agent omp');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('mcp-tool-via-bash');
    const second = await bashCall('tools:invoke {name:"fleet:launch-on-plan", args:{count:3}}');
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 2; i++) {
      const r = await bashCall(`plans:get {attempt:${i}}`); // different each time — dodges the identical breaker
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    expect(reason).toContain('STOP');
    expect(reason).toContain('tools:invoke');
  });

  it('the block reason names the EXACT native tool for the group:verb the model typed (iter32→33 fix)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await bashCall('plans:get {slug:"ornith-comprehension-test-2026-07-04", harness:"papercusp"}');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('mcp__papercusp_su_plans_get');
  });

  it('leaves a legitimate bash command alone', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await bashCall('ls -la apps/operator/lib/llm-testing/fixtures/')).block).toBeUndefined();
    expect((await bashCall("sed -i 's/BROKEN/FIXED/' file.txt")).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await bashCall('fleet:launch-on-plan --count 2')).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — the doom-loop HALTS after the threshold (naming mcp-bash)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        const r = await bashCall(`fleet:launch-on-plan --attempt ${i}`); // different each time
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await bashCall('fleet:launch-on-plan --final');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
      expect(halts[0]).toContain('mcp-bash');
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await bashCall(`fleet:launch-on-plan --i ${i}`)).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('noteReflexiveBlock + resetReflexiveBlockBudget (shared reflexive-block backstop, iter16 / WI-2382)', () => {
  afterEach(() => resetReflexiveBlockBudget());
  it('is session-cumulative across tools and reset clears it', () => {
    resetReflexiveBlockBudget();
    expect(noteReflexiveBlock('irc')).toBe(1);
    expect(noteReflexiveBlock('ask')).toBe(2); // shared — counts across reflexive tools
    resetReflexiveBlockBudget();
    expect(noteReflexiveBlock('irc')).toBe(1);
  });
  it('halts exactly on the Kth call, not before, naming the offending tool', () => {
    resetReflexiveBlockBudget();
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) noteReflexiveBlock('irc');
      expect(halts).toHaveLength(0);
      noteReflexiveBlock('irc');
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('irc');
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('stall watchdog (ornith failure mode #5 — silence, not a loop / WI-2382)', () => {
  // The watchdog uses real timers; fake them so a test asserts the ~6-min halt
  // without waiting, and swap the halt seam so it never SIGTERMs the runner.
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  let halts: string[];
  let prevHalt: (reason: string) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    disarmStallWatchdog();
    noteStallToolInFlight(false);
    halts = [];
    prevHalt = setHaltForTest((r) => halts.push(r));
    process.env.PAPERCUSP_AGENT_SESSION = '1'; // agent session — watchdog is armable
  });
  afterEach(() => {
    disarmStallWatchdog();
    noteStallToolInFlight(false);
    setHaltForTest(prevHalt);
    vi.useRealTimers();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('arms on poke and halts after STALL_WATCHDOG_MS of silence (the wedge)', () => {
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(true);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0); // not yet
    vi.advanceTimersByTime(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toContain('stall-watchdog');
    expect(_stallWatchdogArmed()).toBe(false); // cleared itself on halt
  });

  it('a poke before the deadline RESETS the countdown (progress = no halt)', () => {
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    pokeStallWatchdog(); // an event landed just in time
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0); // the reset gave it a fresh full window
    vi.advanceTimersByTime(1);
    expect(halts).toHaveLength(1);
  });

  it('EXTENDS (does not kill) while a legit tool is in flight, up to the cap', () => {
    noteStallToolInFlight(true); // a long build/test is running
    pokeStallWatchdog();
    // Each window elapses but the tool is still in flight → extend, not halt.
    for (let i = 0; i < STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS; i++) {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
      expect(halts).toHaveLength(0);
    }
    // One more window past the extension cap → a hung tool still halts.
    vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toContain('stall-watchdog');
  });

  it('a finished long tool is NOT killed, but a later stall still is', () => {
    noteStallToolInFlight(true);
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS); // one extension (tool still running)
    expect(halts).toHaveLength(0);
    // tool_result fires: clear in-flight + rearm — the slow tool completed cleanly.
    noteStallToolInFlight(false);
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0);
    vi.advanceTimersByTime(1); // now genuinely wedged between events
    expect(halts).toHaveLength(1);
  });

  it('is NEVER armed for the owner’s own sessions (marker unset — D-003)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * (STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS + 5));
    expect(halts).toHaveLength(0);
  });

  it('disarm clears an armed watchdog so it cannot fire (clean shutdown)', () => {
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(true);
    disarmStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * 2);
    expect(halts).toHaveLength(0);
  });

  it('turn lifecycle: disarmed on turn_end → an idle wait-for-input NEVER halts (iter18 false-positive fix)', () => {
    // Reproduce the iter18 kill: a leader runs a kickoff turn (turn_start + a
    // tool call), then cleanly ENDS the turn (turn_end → disarm) and idles
    // waiting for its routing decision. That idle is silence-identical to a
    // wedge but is legitimate, so it must NOT halt. Mirrors the register()
    // wiring: turn_start/tool_* → poke, turn_end → disarmStallWatchdog.
    pokeStallWatchdog(); // turn_start
    noteStallToolInFlight(true);
    pokeStallWatchdog(); // tool_call (read the plan)
    noteStallToolInFlight(false);
    pokeStallWatchdog(); // tool_result
    expect(_stallWatchdogArmed()).toBe(true);
    disarmStallWatchdog(); // turn_end — clean stop; the leader now idles for input
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * (STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS + 3));
    expect(halts).toHaveLength(0); // an idle wait after a clean turn_end never fires
  });
});

describe('isAskCall + askBlockReason (interactive ask-gate guard, ornith iter10 / WI-2382)', () => {
  it('matches the bare `ask` builtin in every spelling, strips a group prefix', () => {
    expect(isAskCall('ask')).toBe(true);
    expect(isAskCall('ASK')).toBe(true); // case-insensitive
    expect(isAskCall('x:ask')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up unrelated tools whose name merely contains "ask"', () => {
    expect(isAskCall('task')).toBe(false);
    expect(isAskCall('taskcreate')).toBe(false);
    expect(isAskCall('coord:ask-owner')).toBe(false); // bare verb `askowner`, not `ask`
    expect(isAskCall('plans:get')).toBe(false);
    expect(isAskCall('')).toBe(false);
  });
  it('the reason redirects to a TEXT routing gate + coord:ask-owner', () => {
    const r = askBlockReason();
    expect(r).toContain('ask-blocked');
    expect(r).toContain('TEXT');
    expect(r).toContain('coord:ask-owner');
  });
});

describe('onToolCall ask guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const askCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'a', input: { questions: [] } });

  it('blocks an `ask` call on #1 for an agent session, redirecting to a text gate', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await askCall();
    expect(r.block).toBe(true);
    expect(r.reason).toContain('ask-blocked');
    expect(r.reason).toContain('coord:ask-owner');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await askCall()).block).toBeUndefined();
  });

  it('leaves the `task`-family and coord:ask-owner tools to their own handling (no ask sweep)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // coord:ask-owner is the SANCTIONED durable path — it must NOT be swept up by the ask guard.
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'coord:ask-owner',
      toolCallId: 'q',
      input: { question: 'ok' },
    });
    expect(r.reason ?? '').not.toContain('ask-blocked');
  });

  it('escalates the block message once the session ignores it past the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < REFLEXIVE_BLOCK_ESCALATE_AFTER + 2; i++) reason = (await askCall()).reason ?? '';
    expect(reason).toContain('STOP');
  });

  it('structurally HALTS the session after REFLEXIVE_BLOCK_KILL_AFTER blocked ask calls (iter16 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await askCall()).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await askCall();
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await askCall()).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isIrcCall + ircBlockReason (native irc-distraction guard, ornith iter11 / WI-2382)', () => {
  it('matches the bare `irc` builtin in every spelling, strips a group prefix', () => {
    expect(isIrcCall('irc')).toBe(true);
    expect(isIrcCall('IRC')).toBe(true); // case-insensitive
    expect(isIrcCall('x:irc')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up unrelated tools whose name merely contains "irc"', () => {
    expect(isIrcCall('circ')).toBe(false);
    expect(isIrcCall('irc_send')).toBe(false); // bare verb `ircsend`, not `irc`
    expect(isIrcCall('search')).toBe(false);
    expect(isIrcCall('plans:get')).toBe(false);
    expect(isIrcCall('')).toBe(false);
  });
  it('the reason redirects to coord:presence + the kickoff plan read', () => {
    const r = ircBlockReason();
    expect(r).toContain('irc-blocked');
    expect(r).toContain('coord:presence');
    expect(r).toContain('plans:get');
  });
});

describe('onToolCall irc guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const ircCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'irc', toolCallId: 'i', input: {} });
  const askCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'a', input: { questions: [] } });

  it('blocks an `irc` call on #1 for an agent session, redirecting to coord:presence', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await ircCall();
    expect(r.block).toBe(true);
    expect(r.reason).toContain('irc-blocked');
    expect(r.reason).toContain('coord:presence');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await ircCall()).block).toBeUndefined();
  });

  it('escalates the block message once the session ignores it past the threshold (the iter16 loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < REFLEXIVE_BLOCK_ESCALATE_AFTER + 2; i++) reason = (await ircCall()).reason ?? '';
    expect(reason).toContain('STOP');
    expect(reason).toContain('plans:get');
  });

  it('structurally HALTS the session after REFLEXIVE_BLOCK_KILL_AFTER blocked irc calls (iter16 / WI-2382 — the 482× loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await ircCall()).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await ircCall();
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('the backstop is SHARED across reflexive tools — a mixed irc+ask loop still halts at the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Alternate irc/ask; neither alone reaches the threshold, but the shared counter does.
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        await (i % 2 === 0 ? ircCall() : askCall());
      }
      expect(halts).toHaveLength(0);
      await askCall(); // the Kth reflexive block overall
      expect(halts).toHaveLength(1);
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await ircCall()).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isTodoCall + todoLoopReason (todo doom-loop guard, ornith iter19 / WI-2382)', () => {
  it('matches the legit todo tool in every spelling, strips a group prefix', () => {
    expect(isTodoCall('todo')).toBe(true);
    expect(isTodoCall('todo_write')).toBe(true);
    expect(isTodoCall('todowrite')).toBe(true);
    expect(isTodoCall('TodoWrite')).toBe(true); // case-insensitive
    expect(isTodoCall('x:todo')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up the already-blocked task* panel tools or unrelated names', () => {
    expect(isTodoCall('task')).toBe(false);
    expect(isTodoCall('taskcreate')).toBe(false);
    expect(isTodoCall('taskupdate')).toBe(false);
    expect(isTodoCall('todos')).toBe(false); // bare verb `todos`, not `todo`/`todowrite`
    expect(isTodoCall('plans:get')).toBe(false);
    expect(isTodoCall('')).toBe(false);
  });
  it('the reason redirects to the next real action (plans:get) and escalates to a hard STOP', () => {
    const base = todoLoopReason(TODO_LOOP_LIMIT + 1);
    expect(base).toContain('todo-loop');
    expect(base).toContain('plans:get');
    expect(base).not.toContain('STOP —');
    const hard = todoLoopReason(TODO_LOOP_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('plans:get');
  });
});

describe('onToolCall todo guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetTodoLoopState();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetTodoLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // VARIED input each call — the whole point: the generic identical-call breaker cannot catch a
  // todo loop whose list keeps CHANGING (iter19's leader rewrote its list every turn), so these must
  // accumulate on the input-agnostic counter, not the identical-repeat one. Vary the list LENGTH
  // (`(i % 3) + 1` → 1,2,3,1,2,3…, never 3 consecutive equal): toolCallLoopKey uses a replacer array
  // that strips nested object keys, so ONLY a top-level-visible change (list length) makes the keys
  // differ — matching how a real rewrite loop slips past the identical-repeat breaker.
  const todoCall = (i: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'todo_write',
      toolCallId: `t${i}`,
      input: {
        todos: Array.from({ length: (i % 3) + 1 }, (_, k) => ({ content: `s${k}`, status: 'pending' })),
      },
    });
  const productiveCall = (i: number) =>
    onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: `r${i}`, input: { file_path: `/x/${i}` } });

  it('allows the first TODO_LOOP_LIMIT todo calls, then blocks with an input-agnostic redirect', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) {
      expect((await todoCall(i)).block).toBeUndefined();
    }
    const over = await todoCall(TODO_LOOP_LIMIT);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('todo-loop');
  });

  it('a productive non-todo tool call RESETS the run (legit interleaved todos never trip)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // Right up to the limit…
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) expect((await todoCall(i)).block).toBeUndefined();
    // …then a real action resets it, so the next full run of todos is allowed again.
    expect((await productiveCall(0)).block).toBeUndefined();
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) {
      expect((await todoCall(100 + i)).block).toBeUndefined();
    }
    // Only a run with NO productive call between finally trips.
    expect((await todoCall(200)).block).toBe(true);
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let i = 0; i < TODO_LOOP_LIMIT + 5; i++) {
      expect((await todoCall(i)).block).toBeUndefined();
    }
  });

  it('escalates the message to a hard STOP once the session ignores it past the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < TODO_LOOP_ESCALATE_AFTER + 1; i++) reason = (await todoCall(i)).reason ?? '';
    expect(reason).toContain('STOP');
  });

  it('feeds the SHARED reflexive-block backstop — a pure todo loop HALTS after the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Warm-up: the allowed calls do NOT feed the backstop.
      for (let i = 0; i < TODO_LOOP_LIMIT; i++) await todoCall(i);
      // Now the blocked calls each note a reflexive block; one short of the kill threshold.
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await todoCall(1000 + i)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // The Kth reflexive block halts the runaway.
      expect((await todoCall(2000)).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('todo');
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < TODO_LOOP_LIMIT + REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await todoCall(i)).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('noteTodoCall / resetTodoLoopState behave as a simple counter (unit)', () => {
    resetTodoLoopState();
    expect(noteTodoCall()).toBe(1);
    expect(noteTodoCall()).toBe(2);
    resetTodoLoopState();
    expect(noteTodoCall()).toBe(1);
  });
});

describe('isShellTool + shellBudgetReason (per-turn shell budget)', () => {
  it('recognizes bash/shell (case-insensitive), not other tools', () => {
    expect(isShellTool('bash')).toBe(true);
    expect(isShellTool('Bash')).toBe(true);
    expect(isShellTool('shell')).toBe(true);
    expect(isShellTool('read')).toBe(false);
    expect(isShellTool('resolve')).toBe(false);
  });
  it('the steer says converge-or-report and keeps non-shell tools open', () => {
    const r = shellBudgetReason(41);
    expect(r).toContain('41 shell commands');
    expect(r).toMatch(/converg|report/i);
    expect(r).toContain('Non-shell tools remain available');
  });
});

describe('onToolCall shell budget (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // A distinct bash command each call, so the identical-repeat breaker never fires
  // and we isolate the budget (the EI-7092 wandering-search shape).
  const wanderingBash = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: `b${n}`,
      input: { command: `grep -rn "sym_${n}" /repo` },
    });

  it('allows shell calls up to the budget, blocks the one past it with a converge steer', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT; n++) {
      expect((await wanderingBash(n)).block).toBeUndefined();
    }
    const over = await wanderingBash(SHELL_CALLS_PER_TURN_LIMIT + 1);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('shell-budget');
  });

  it('non-shell tools stay OPEN after the budget is spent (so the model can still report/finish)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 3; n++) await wanderingBash(n);
    const read = await onToolCall({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'r',
      input: { path: 'a.ts' },
    });
    expect(read.block).toBeUndefined();
  });

  it('resets per turn — a fresh turn restores the full shell budget', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 1; n++) await wanderingBash(n);
    resetToolCallLoopState(); // turn_start
    expect((await wanderingBash(999)).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 5; n++) {
      expect((await wanderingBash(n)).block).toBeUndefined();
    }
  });
});

describe('isFleetLaunchCall + fleetLaunchBudgetReason (session fleet-launch budget)', () => {
  it('recognizes every surface spelling of the launch verb', () => {
    expect(isFleetLaunchCall('mcp__papercusp_su_fleet_launch_on_plan', {})).toBe(true);
    expect(isFleetLaunchCall('fleet:launch-on-plan', {})).toBe(true);
    expect(isFleetLaunchCall('fleet_launch_on_plan', {})).toBe(true);
    expect(
      isFleetLaunchCall('mcp__papercusp_su_tools_invoke', { name: 'fleet:launch-on-plan' }),
    ).toBe(true);
    expect(isFleetLaunchCall('mcp__papercusp_su_tools_invoke', { name: 'plans:get' })).toBe(false);
    expect(isFleetLaunchCall('fleet_status', {})).toBe(false);
    expect(isFleetLaunchCall('bash', { command: 'fleet_launch_on_plan' })).toBe(false);
  });
  it('the steer says supervise-instead and forbids re-calling', () => {
    const r = fleetLaunchBudgetReason(3);
    expect(r).toContain('fleet-launch budget');
    expect(r).toContain('fleet:status');
    expect(r).toMatch(/do not re-call/i);
  });
});

describe('onToolCall fleet-launch budget (agent sessions only, session-cumulative)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
    resetFleetLaunchBudget();
    resetReflexiveBlockBudget(); // the budget block now feeds the shared reflexive backstop (gap A)
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetFleetLaunchBudget();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // Run-10 shape: launch re-calls INTERLEAVED with loop:checkpoint, so the
  // consecutive-identical breaker never sees a run — only the budget catches it.
  const launchCall = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_fleet_launch_on_plan',
      toolCallId: `fl${n}`,
      input: { name: 'ornith-verify-2', plan: 'p', count: 2, i: `attempt ${n}` },
    });
  const checkpointCall = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_loop_checkpoint',
      toolCallId: `cp${n}`,
      input: { did: `d${n}` },
    });

  it('run-10: blocks the launch call past the session budget even when interleaved', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await launchCall(1)).block).toBeUndefined();
    expect((await checkpointCall(1)).block).toBeUndefined();
    expect((await launchCall(2)).block).toBeUndefined();
    expect((await checkpointCall(2)).block).toBeUndefined();
    const third = await launchCall(3);
    expect(third.block).toBe(true);
    expect(third.reason).toContain('fleet-launch budget');
  });

  it('the budget survives turn_start (session-cumulative, not per-turn)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    await launchCall(1);
    await launchCall(2);
    resetToolCallLoopState(); // turn_start resets ONLY the turn-scoped counters
    const third = await launchCall(3);
    expect(third.block).toBe(true);
  });

  it('catches the tools:invoke-wrapped launch too', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const wrapped = (n: number) =>
      onToolCall({
        type: 'tool_call',
        toolName: 'mcp__papercusp_su_tools_invoke',
        toolCallId: `w${n}`,
        input: { name: 'fleet:launch-on-plan', args: { plan: 'p', count: 2, i: `a${n}` } },
      });
    expect((await wrapped(1)).block).toBeUndefined();
    expect((await wrapped(2)).block).toBeUndefined();
    expect((await wrapped(3)).block).toBe(true);
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 1; n <= FLEET_LAUNCH_CALLS_PER_SESSION + 3; n++) {
      expect((await launchCall(n)).block).toBeUndefined();
    }
  });

  // gap A (ornith iter35, 2026-07-05 / WI-2382): the budget guard was the ONE repeat-class
  // guard NOT wired to the shared reflexive backstop, so a leader that reflexively re-issued
  // the launch PAST the budget was blocked every time yet NEVER self-terminated. Vary a
  // NON-noise field (`plan`) each call so the session-repeat breaker (which strips only the
  // noise fields) never fires first — isolating the budget guard's OWN reflexive feed.
  const variedLaunch = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_fleet_launch_on_plan',
      toolCallId: `vfl${n}`,
      input: { name: 'ornith-verify-2', plan: `plan-${n}`, count: 2 },
    });

  it('gap A: a launch doom-loop PAST the budget feeds the shared reflexive backstop and HALTS', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls #1-2 are within budget: allowed, and must NOT feed the reflexive halt.
      expect((await variedLaunch(1)).block).toBeUndefined();
      expect((await variedLaunch(2)).block).toBeUndefined();
      // Each over-budget launch is blocked AND feeds the shared backstop. The halt fires on
      // the REFLEXIVE_BLOCK_KILL_AFTER-th blocked launch (call #(2+KILL_AFTER)), not before.
      for (let k = 3; k <= 1 + REFLEXIVE_BLOCK_KILL_AFTER; k++) {
        const r = await variedLaunch(k);
        expect(r.block).toBe(true);
        expect(r.reason).toContain('fleet-launch budget');
      }
      expect(halts).toHaveLength(0);
      const halting = await variedLaunch(2 + REFLEXIVE_BLOCK_KILL_AFTER);
      expect(halting.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('reflexive-block doom-loop');
      expect(halts[0]).toContain('fleet-launch');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isLocalModel / getOwnLaunchedModel / fleetLaunchMemberModel (fleet-launch model guard #8)', () => {
  it('isLocalModel recognizes local/gateway specs, not cloud', () => {
    expect(isLocalModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true);
    expect(isLocalModel('ollama/llama3')).toBe(true);
    expect(isLocalModel('some-ORNITH-build')).toBe(true); // case-insensitive
    expect(isLocalModel('maxwell1500')).toBe(true);
    expect(isLocalModel('claude')).toBe(false);
    expect(isLocalModel('opus:high')).toBe(false);
    expect(isLocalModel('sonnet')).toBe(false);
    expect(isLocalModel(undefined)).toBe(false);
    expect(isLocalModel('')).toBe(false);
  });
  it('getOwnLaunchedModel reads --model / --model= from argv (fail-open when absent)', () => {
    const orig = process.argv;
    try {
      process.argv = ['bun', 'omp', '--model', 'ollama-cc/maxwell1500/ornith-35b:IQ3_M'];
      expect(getOwnLaunchedModel()).toBe('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
      process.argv = ['bun', 'omp', '--model=opus:high'];
      expect(getOwnLaunchedModel()).toBe('opus:high');
      process.argv = ['bun', 'omp', '--no-lsp'];
      expect(getOwnLaunchedModel()).toBeUndefined();
    } finally {
      process.argv = orig;
    }
  });
  it('fleetLaunchMemberModel extracts from direct + tools:invoke-wrapped args', () => {
    expect(fleetLaunchMemberModel({ model: 'x' })).toBe('x');
    expect(fleetLaunchMemberModel({ name: 'fleet:launch-on-plan', args: { model: 'y' } })).toBe('y');
    expect(fleetLaunchMemberModel({ name: 'fleet:launch-on-plan', args: { count: 2 } })).toBeUndefined();
    expect(fleetLaunchMemberModel(undefined)).toBeUndefined();
  });
  it('fleetLaunchModelReason names the own model + the required arg', () => {
    const r = fleetLaunchModelReason('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
    expect(r).toContain('fleet-launch model guard');
    expect(r).toContain('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
    expect(r).toContain('model:');
  });
});

describe('onToolCall fleet-launch member-model guard (ornith mode #8 / WI-2382)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  const prevArgv = process.argv;
  const ORNITH = 'ollama-cc/maxwell1500/ornith-35b:IQ3_M';
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetFleetLaunchBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.argv = prevArgv;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetFleetLaunchBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const withOwnModel = (m: string) => {
    process.argv = ['bun', '/home/x/.bun/bin/omp', '--no-lsp', '--model', m];
  };
  const launch = (args: Record<string, unknown>) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: 'fl',
      input: { name: 'fleet:launch-on-plan', args },
    });

  it('blocks a local-model agent that launches WITHOUT a local member model (the iter22 bug)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await launch({ name: 'f', plan: 'p', count: 2, agent: 'omp' }); // no model
    expect(r.block).toBe(true);
    expect(r.reason).toContain('fleet-launch model guard');
    expect(r.reason).toContain(ORNITH);
  });

  it('also blocks when the launch pins a CLOUD member model', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p', model: 'claude' })).block).toBe(true);
  });

  it('ALLOWS the launch when a local member model is pinned', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p', agent: 'omp', model: ORNITH })).block).toBeUndefined();
  });

  it('does NOT fire for a CLOUD-model omp session (own model not local)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel('opus:high');
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('does NOT fire when the own model is undetectable — fail-open (no --model in argv)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--no-lsp'];
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('does NOT consume the fleet-launch budget on a wrong-model block (a corrected retry stays possible)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    // 3 wrong-model attempts (varied fleet name so the generic identical-call breaker doesn't
    // short-circuit them) — all model-blocked, none reach the budget counter…
    for (let i = 0; i < 3; i++) expect((await launch({ name: 'wm' + i, plan: 'p' })).block).toBe(true);
    // …so a correct launch is still allowed (budget of 2 not yet spent).
    expect((await launch({ name: 'ok1', plan: 'p', model: ORNITH })).block).toBeUndefined();
    expect((await launch({ name: 'ok2', plan: 'p', model: ORNITH })).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — a persistent wrong-model loop HALTS (naming fleet-model)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Varied fleet name each call so the generic identical-call breaker never short-circuits them
      // (each must reach the #8 guard, which feeds the shared reflexive backstop).
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await launch({ name: 'f' + i, plan: 'p' })).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      expect((await launch({ name: 'f-final', plan: 'p' })).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('fleet-model');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isClaimNextCall + claimNextBlockReason (backlog-wandering containment #11 / WI-2382)', () => {
  it('matches claim_next in direct + tools:invoke-wrapped spellings', () => {
    expect(isClaimNextCall('mcp__papercusp_su_work_items_claim_next', {})).toBe(true);
    expect(isClaimNextCall('work_items:claim_next', {})).toBe(true);
    expect(isClaimNextCall('work-items-claim-next', {})).toBe(true);
    expect(
      isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'work_items:claim_next' }),
    ).toBe(true);
    expect(isClaimNextCall('tools:invoke', { name: 'work_items:claim_next' })).toBe(true);
  });
  it('does NOT match the by-id claim path or unrelated tools', () => {
    // work_items:claim (specific assigned item) stays open — it is NOT claim_next.
    expect(isClaimNextCall('work_items:claim', {})).toBe(false);
    expect(isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'work_items:claim' })).toBe(false);
    expect(isClaimNextCall('work_items:claim_replica', {})).toBe(false);
    expect(isClaimNextCall('plans:get', {})).toBe(false);
    expect(isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'plans:get' })).toBe(false);
    // a bash command merely mentioning claim_next is not a claim_next tool call
    expect(isClaimNextCall('bash', { command: 'echo claim_next' })).toBe(false);
  });
  it('claimNextBlockReason steers to the assigned plan + names the by-id escape hatch', () => {
    const r = claimNextBlockReason();
    expect(r).toContain('claim_next');
    expect(r).toContain('plans:get');
    expect(r).toContain('work_items:claim');
    expect(r).toContain('WI-2046');
  });
});

describe('onToolCall claim_next containment guard (ornith mode #11 / WI-2382)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  const prevArgv = process.argv;
  const ORNITH = 'ollama-cc/maxwell1500/ornith-35b:IQ3_M';
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.argv = prevArgv;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const withOwnModel = (m: string) => {
    process.argv = ['bun', '/home/x/.bun/bin/omp', '--no-lsp', '--model', m];
  };
  const claimNext = (id: string) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: id,
      input: { name: 'work_items:claim_next', args: {} },
    });

  it('blocks claim_next for a LOCAL-model agent session (the iter27 WI-2046 bug)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await claimNext('cn1');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('claim_next');
    expect(r.reason).toContain('plans:get');
  });

  it('ALLOWS the by-id claim path for the same local-model session', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: 'cbyid',
      input: { name: 'work_items:claim', args: { id: 'WI-2046' } },
    });
    expect(r.block).toBeUndefined();
  });

  it('does NOT fire for a CLOUD-model omp session (own model not local)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel('opus:high');
    expect((await claimNext('cn-cloud')).block).toBeUndefined();
  });

  it('does NOT fire when the own model is undetectable — fail-open (no --model in argv)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--no-lsp'];
    expect((await claimNext('cn-noarg')).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    withOwnModel(ORNITH);
    expect((await claimNext('cn-owner')).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — a persistent claim_next loop HALTS (naming claim-next)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await claimNext('cn-loop' + i)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      expect((await claimNext('cn-final')).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('claim-next');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('onToolCall native-scheduler guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    // The allow paths fall through to the fire-and-forget activity report —
    // stub fetch so no test ever touches the network.
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('blocks an OS-scheduler bash command when the agent-session marker is set', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-1',
      input: { command: 'cd /tmp && crontab evil-tab' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('pot:declare-wake');
  });

  it('covers bash variants (bash_interactive etc.) via the prefix match', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash_interactive',
      toolCallId: 'sched-2',
      input: { command: 'at 5pm' },
    });
    expect(r.block).toBe(true);
  });

  it('allows non-scheduler commands in agent sessions', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-3',
      input: { command: 'git status' },
    });
    expect(r.block).toBeUndefined();
  });

  it("never fires for the owner's own sessions (marker unset — D-003)", async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-4',
      input: { command: 'crontab -l' },
    });
    expect(r.block).toBeUndefined();
  });
});

/**
 * Build a temp papercup-style workspace with one `.git` worktree and a
 * cleanup fn. The hook resolves a path's worktree by walking up to
 * `.git`, gated on that worktree being a direct child of
 * PAPERCUSP_WORKSPACE_ROOT (mirrors the cc hook), so fixtures need a real
 * on-disk `.git`. The base is realpath'd so the dirname/workspace
 * comparison is symlink-stable (macOS tmpdir is symlinked).
 */
async function makeWorktreeFixture(): Promise<{
  workspace: string;
  repo: string;
  cleanup: () => Promise<void>;
}> {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'omp-hook-ws-')),
  );
  const repo = join(base, 'papercusp'); // canonical staging tree (worktree guard default: <ws>/papercusp)
  await fs.mkdir(join(repo, '.git'), { recursive: true });
  return {
    workspace: base,
    repo,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

describe('formatTurnStartReminder', () => {
  it('returns "" when there is nothing to surface', () => {
    expect(
      formatTurnStartReminder({
        ownerId: 'a',
        inbox: [],
        heldLocks: [],
        changedPlans: [],
      }),
    ).toBe('');
  });

  it('renders escalations first within the inbox', () => {
    const inbox: InboxEntry[] = [
      {
        ts: '2026-05-20T00:00:00Z',
        msg_id: 'm1',
        from: 'B',
        kind: 'message',
        summary: 'hi',
      },
      {
        ts: '2026-05-20T00:00:01Z',
        msg_id: 'm2',
        from: 'C',
        kind: 'escalation',
        severity: 'blocker',
        summary: 'urgent',
      },
    ];
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox,
      heldLocks: [],
      changedPlans: [],
    });
    expect(out).toContain('<system-reminder type="coord">');
    expect(out).toContain('Inbox — 2 unread');
    // escalation should appear before the plain message line in output order
    expect(out.indexOf('escalation:blocker')).toBeLessThan(
      out.indexOf('[message from B]'),
    );
  });

  it('truncates long lists and surfaces a "… and N more" hint for locks', () => {
    const heldLocks = Array.from({ length: 8 }, (_, i) => ({
      path: `apps/operator/x${i}.ts`,
    }));
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox: [],
      heldLocks,
      changedPlans: [],
    });
    expect(out).toContain('currently hold 8 locks');
    expect(out).toContain('… and 3 more');
  });

  it('renders changed-plans block when present', () => {
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox: [],
      heldLocks: [],
      changedPlans: [
        { plan_slug: 'foo-2026-05-20', events: ['decision_added', 'now_updated'] },
      ],
    });
    expect(out).toContain('Plans changed since you last read');
    expect(out).toContain('foo-2026-05-20 — decision_added, now_updated');
  });
});

describe('register (OMP adapter)', () => {
  /**
   * Smoke test for the corrected OMP HookAPI contract (verified
   * 2026-05-20 against @oh-my-pi/pi-coding-agent installed version):
   *
   *   - session_start / turn_start handler return values are DISCARDED
   *   - tool_call may return ToolCallEventResult to block
   *   - turn_start injects via pi.sendMessage(), not via return value
   */
  it('subscribes session_start, turn_start, and tool_call', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ msg: unknown; opts?: unknown }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: unknown, opts?: unknown) => {
        sent.push({ msg, opts });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);
    expect([...subs.keys()].sort()).toEqual([
      'session_shutdown',
      'session_start',
      'tool_call',
      'tool_result',
      'turn_end',
      'turn_start',
    ]);
    // tool_call handler permits an empty edit (no path → nothing to
    // claim → fall through). file-locking #2 covers the real busy /
    // unreachable / release paths in their own describe blocks.
    const block = await subs.get('tool_call')!(
      { type: 'tool_call', toolName: 'edit', toolCallId: 't1', input: {} },
      {},
    );
    expect(block).toEqual({});
  });

  it('operator unreachable with no coord work sends no hidden reminder (F-H4)', async () => {
    // No operator configured in the unit-test env (no PAPERCUSP_*_URL),
    // so probeOperator() → false → the turn resolves to DETACHED mode.
    // Detached is a supported mode, not a failure. Empty detached turns
    // must not send a hidden reminder: OMP treats sendMessage() as a
    // conversation event, which can otherwise auto-continue forever.
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ content: unknown }> = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { content: unknown }) => {
        sent.push({ content: msg.content });
      },
    };
    const prevCoordDir = process.env.PAPERCUSP_COORD_DIR;
    const tmpCoordDir = await fs.mkdtemp(join(tmpdir(), 'coord-hook-empty-'));
    process.env.PAPERCUSP_COORD_DIR = tmpCoordDir;
    // The hook reaches the operator via these env vars (callMcpTool). On a dev
    // box one is set + a real operator is up, so the probe would succeed and
    // read live coord data — defeating the "no operator → detached" premise.
    // Clear them so the turn deterministically resolves to DETACHED.
    const opEnvKeys = ['PAPERCUSP_BUNDLE_URL', 'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_API_BASE'] as const;
    const prevOpEnv = Object.fromEntries(opEnvKeys.map((k) => [k, process.env[k]]));
    for (const k of opEnvKeys) delete process.env[k];
    try {
      const { default: register } = await import('../coord-hook');
      register(pi as never);
      const ctx = {
        hasUI: true,
        ui: {
          notify: (message: string, type?: string) => {
            notifications.push({ message, type });
          },
        },
      };
      await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 0, timestamp: 0 }, ctx);
      expect(sent).toEqual([]);
      // Detached is not an error — no warning notification.
      expect(notifications.length).toBe(0);
    } finally {
      if (prevCoordDir === undefined) delete process.env.PAPERCUSP_COORD_DIR;
      else process.env.PAPERCUSP_COORD_DIR = prevCoordDir;
      for (const k of opEnvKeys) {
        if (prevOpEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevOpEnv[k];
      }
      await fs.rm(tmpCoordDir, { recursive: true, force: true });
    }
  });
});

// WI-1082: when the operator is reachable but a coordination READ is intermittently
// slow (e.g. a bg-host restart-loop), onTurnStart returns degraded:true. Re-injecting
// the degraded notice EVERY such turn spams the model + TUI and, in an auto-continuing
// omp session, drives a self-reinforcing turn loop (one user session logged 79 notices
// in 170s). The notice is now EDGE-TRIGGERED: surfaced once per slow streak, re-armed
// only after coordination recovers.
describe('degraded notice is edge-triggered (WI-1082 — no per-turn spam / loop)', () => {
  const originalFetch = global.fetch;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevToken = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  let inboxFails = true;
  function installFetch() {
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      // probeOperator → reachable (so the turn stays ATTACHED, not DETACHED).
      if (u.includes('/api/health')) return { ok: true, text: async () => 'ok' };
      const body = init?.body ? JSON.parse(init.body) : {};
      const tool = body?.params?.name as string | undefined;
      // coord:inbox returns null (not ok) → degraded; everything else succeeds.
      if (tool === 'coord:inbox' && inboxFails) {
        return { ok: false, text: async () => 'err' };
      }
      const payload =
        tool === 'coord:inbox'
          ? { ok: true, entries: [] }
          : { ok: true, entries: [], events: [], active_locks: [], watermark: {} };
      return {
        ok: true,
        text: async () =>
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
      };
    }) as unknown as typeof fetch;
  }
  beforeEach(() => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-degr';
    inboxFails = true;
    _resetHookOwnerIdForTests();
    _resetDegradedNotifiedForTests();
    installFetch();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevToken === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    _resetHookOwnerIdForTests();
    _resetDegradedNotifiedForTests();
  });

  it('surfaces the degraded notice ONCE across a streak, and re-arms after recovery', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ content: string }> = [];
    const notifications: Array<{ message: string }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { content: unknown }) => {
        sent.push({ content: String(msg.content) });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);
    const ctx = {
      hasUI: true,
      ui: { notify: (message: string) => notifications.push({ message }) },
    };
    const degradedNotes = () =>
      sent.filter((s) => s.content.includes('coordination read was slow')).length;

    // 3 consecutive degraded turns → exactly ONE degraded notice + ONE TUI notification.
    for (let i = 0; i < 3; i++) {
      await subs.get('turn_start')!({ type: 'turn_start', turnIndex: i, timestamp: 0 }, ctx);
    }
    expect(degradedNotes()).toBe(1);
    expect(notifications.length).toBe(1);

    // Operator recovers → a healthy turn re-arms the latch (still just one notice).
    inboxFails = false;
    await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 3, timestamp: 0 }, ctx);
    expect(degradedNotes()).toBe(1);

    // Slow again → a fresh streak surfaces exactly one MORE notice (re-armed).
    inboxFails = true;
    await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 4, timestamp: 0 }, ctx);
    expect(degradedNotes()).toBe(2);
    expect(notifications.length).toBe(2);
  });
});

describe('probeOperator', () => {
  it('returns false when no operator URL is configured', async () => {
    const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
    const prevOp = process.env.PAPERCUSP_OPERATOR_URL;
    delete process.env.PAPERCUSP_BUNDLE_URL;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    const { probeOperator } = await import('../coord-hook');
    expect(await probeOperator(200)).toBe(false);
    if (prevBundle !== undefined) process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevOp !== undefined) process.env.PAPERCUSP_OPERATOR_URL = prevOp;
  });
});

describe('summarisePlanEvents', () => {
  it('groups plan_event entries by plan_slug, preserving order', () => {
    const events: InboxEntry[] = [
      // not a plan_event — ignored
      { ts: 't', msg_id: 'a', from: 's', kind: 'message' },
      // plan_event lines (the hook gets them in the inbox stream)
      {
        ts: 't',
        msg_id: 'b',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p1',
        ...({ event: 'created' } as Record<string, unknown>),
      } as InboxEntry,
      {
        ts: 't',
        msg_id: 'c',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p1',
        ...({ event: 'now_updated' } as Record<string, unknown>),
      } as InboxEntry,
      {
        ts: 't',
        msg_id: 'd',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p2',
        ...({ event: 'created' } as Record<string, unknown>),
      } as InboxEntry,
    ];
    const out = summarisePlanEvents(events);
    expect(out).toEqual([
      { plan_slug: 'p1', events: ['created', 'now_updated'] },
      { plan_slug: 'p2', events: ['created'] },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking-improvements #2 — onToolCall / onToolResult enforcement
// ────────────────────────────────────────────────────────────────────

describe('extractPathsFromToolInput (file-locking #2)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;
  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fx.cleanup();
  });

  it('claims `path` from a write tool input', () => {
    expect(
      extractPathsFromToolInput('write', { path: join(repo, 'a.ts') }),
    ).toEqual(['a.ts']);
  });

  it('accepts path | file_path | filePath for edit', () => {
    expect(
      extractPathsFromToolInput('edit', { path: join(repo, 'a.ts') }),
    ).toEqual(['a.ts']);
    expect(
      extractPathsFromToolInput('edit', { file_path: join(repo, 'b.ts') }),
    ).toEqual(['b.ts']);
    expect(
      extractPathsFromToolInput('edit', { filePath: join(repo, 'c.ts') }),
    ).toEqual(['c.ts']);
  });

  it('claims every literal path from ast_edit, drops globs', () => {
    expect(
      extractPathsFromToolInput('ast_edit', {
        paths: [
          join(repo, 'a.ts'),
          join(repo, 'dir/*.ts'),
          join(repo, 'b.ts'),
          join(repo, 'x?.ts'),
        ],
        ops: [],
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('drops paths outside any coordinated worktree', () => {
    // No git repo above /etc on this host.
    expect(
      extractPathsFromToolInput('write', { path: '/etc/passwd' }),
    ).toEqual([]);
    // The worktree root itself is never claimed.
    expect(extractPathsFromToolInput('write', { path: repo })).toEqual([]);
  });

  it('keys sibling worktrees by the same repo-relative path (cross-worktree contention)', async () => {
    const repo2 = join(fx.workspace, 'papercup-topic');
    await fs.mkdir(join(repo2, '.git'), { recursive: true });
    const k1 = extractPathsFromToolInput('write', {
      path: join(repo, 'apps/foo.ts'),
    });
    const k2 = extractPathsFromToolInput('write', {
      path: join(repo2, 'apps/foo.ts'),
    });
    expect(k1).toEqual(['apps/foo.ts']);
    expect(k2).toEqual(['apps/foo.ts']); // same key → the two edits contend
  });

  it('drops a git repo that is NOT a direct child of the workspace (e.g. a submodule)', async () => {
    // Nearest `.git` is the nested repo, whose parent is not the
    // workspace — left unguarded, matching the cc hook's gate.
    const nested = join(repo, 'libs', 'sub');
    await fs.mkdir(join(nested, '.git'), { recursive: true });
    expect(
      extractPathsFromToolInput('write', { path: join(nested, 'x.ts') }),
    ).toEqual([]);
  });

  it('returns [] for non-file-editing tools', () => {
    expect(extractPathsFromToolInput('bash', { command: 'ls' })).toEqual([]);
    expect(
      extractPathsFromToolInput('read', { path: join(repo, 'a.ts') }),
    ).toEqual([]);
  });

  it('returns [] for malformed input (non-string path)', () => {
    expect(extractPathsFromToolInput('write', { path: 42 })).toEqual([]);
    expect(extractPathsFromToolInput('write', {})).toEqual([]);
    expect(
      extractPathsFromToolInput('ast_edit', { paths: [null, 7, ''] }),
    ).toEqual([]);
  });
});

describe('formatBusyRefusal (file-locking #2)', () => {
  it('renders the holder line + three retry options', () => {
    const out = formatBusyRefusal([
      {
        path: 'a.ts',
        owner: 'pus-1',
        owner_label: 'A',
        intent: 'editing',
        expires_ts: '2026-05-20T10:00:00Z',
      },
    ]);
    expect(out).toContain('a.ts');
    expect(out).toContain('A');
    expect(out).toContain('"editing"');
    expect(out).toContain('2026-05-20T10:00:00Z');
    expect(out).toMatch(/Options.*\(1\).*\(2\).*\(3\)/s);
  });

  it('truncates after 5 entries with a "... and N more" line', () => {
    const busy = Array.from({ length: 8 }, (_, i) => ({
      path: `p${i}.ts`,
      owner_label: 'X',
      intent: 'i',
      expires_ts: 't',
    }));
    const out = formatBusyRefusal(busy);
    expect(out).toContain('... and 3 more');
    expect(out).toContain('p4.ts');
    expect(out).not.toContain('p5.ts');
  });
});

describe('onToolCall / onToolResult (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-test';
    _resetToolCallCacheForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    await fx.cleanup();
  });

  function mockMcpResponse(payload: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          },
        }),
    })) as unknown as typeof fetch;
  }

  it('returns {} + acquires NO lock when the tool has no claimable path', async () => {
    // The activity bridge now reports EVERY tool call (a fire-and-forget
    // activity:report), so a non-edit tool DOES reach the operator — but it must
    // still acquire NO lock. Assert on the lock call, not on "fetch never fired".
    const names: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      names.push((JSON.parse(init.body) as { params: { name: string } }).params.name);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 't1',
      input: { command: 'ls' },
    });
    expect(r).toEqual({});
    // Let the fire-and-forget activity report settle, then assert no lock was taken.
    await new Promise((res) => setTimeout(res, 20));
    expect(names).not.toContain('locks:acquire');
  });

  it('blocks Claude task-panel and subagent Task tools and points agents at todo_write', async () => {
    for (const toolName of ['TaskUpdate', 'task']) {
      let called = false;
      global.fetch = (async () => {
        called = true;
        throw new Error('should not call');
      }) as unknown as typeof fetch;
      const r = await onToolCall({
        type: 'tool_call',
        toolName,
        toolCallId: 't-task',
        input: { taskId: '1', status: 'in_progress' },
      });
      expect(r.block).toBe(true);
      expect(r.reason).toMatch(/todo_write/i);
      expect(called).toBe(false);
    }
  });

  it('feeds the shared reflexive backstop so a reflexive task-loop HALTS + redirects to fleet:launch-on-plan (mode #10)', async () => {
    const prev = process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    resetReflexiveBlockBudget();
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      const taskCall = () =>
        onToolCall({ type: 'tool_call', toolName: 'task', toolCallId: 'tk', input: { description: 'spawn a worker' } });
      const first = await taskCall();
      expect(first.block).toBe(true);
      expect(first.reason).toContain('fleet:launch-on-plan'); // the delegating leader is pointed at the RIGHT tool
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 2; i++) expect((await taskCall()).block).toBe(true);
      expect(halts).toHaveLength(0);
      await taskCall(); // the REFLEXIVE_BLOCK_KILL_AFTER-th blocked task call
      expect(halts).toHaveLength(1);
    } finally {
      setHaltForTest(prevHalt);
      resetReflexiveBlockBudget();
      if (prev === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
      else process.env.PAPERCUSP_AGENT_SESSION = prev;
    }
  });

  it('blocks task for the owner too but NEVER halts them (marker unset — D-003)', async () => {
    const prev = process.env.PAPERCUSP_AGENT_SESSION;
    delete process.env.PAPERCUSP_AGENT_SESSION;
    resetReflexiveBlockBudget();
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await onToolCall({ type: 'tool_call', toolName: 'task', toolCallId: 'tk', input: {} })).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
      resetReflexiveBlockBudget();
      if (prev === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
      else process.env.PAPERCUSP_AGENT_SESSION = prev;
    }
  });

  it('caches lock_id on ok and releases on tool_result', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload =
        body.params.name === 'locks:acquire'
          ? { ok: true, lock_id: 'L-1', expires_ts: 't', held: ['a.ts'] }
          : { ok: true };
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
            },
          }),
      };
    }) as unknown as typeof fetch;

    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-1',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    expect(r).toEqual({});
    // The activity bridge also fires a fire-and-forget activity:report on every tool
    // call, so filter to the lock calls to assert the lock behavior precisely.
    const lockCalls = () => calls.filter((c) => c.name.startsWith('locks:'));
    expect(lockCalls()).toHaveLength(1);
    expect(lockCalls()[0].name).toBe('locks:acquire');

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(lockCalls()).toHaveLength(2);
    expect(lockCalls()[1].name).toBe('locks:release');
    expect((lockCalls()[1].args as { lock_id: string }).lock_id).toBe('L-1');

    // Second release on the same toolCallId is a no-op (cache cleared).
    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(lockCalls()).toHaveLength(2);
  });

  it('blocks with a formatted reason on busy', async () => {
    global.fetch = mockMcpResponse({
      ok: false,
      busy: [
        {
          path: 'a.ts',
          owner: 'pus-other',
          owner_label: 'OTHER',
          intent: 'editing',
          expires_ts: '2026-05-20T10:00:00Z',
        },
      ],
    });
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-2',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/a\.ts/);
    expect(r.reason).toMatch(/OTHER/);
    expect(r.reason).toMatch(/Options/);
  });

  it('fails open when the operator is unreachable', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const errs: unknown[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a);
    };
    try {
      const r = await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'tc-3',
        input: { path: join(repo, 'a.ts'), content: 'x' },
      });
      expect(r).toEqual({}); // fail open
      expect(errs.some((e) => String(e).includes('fail-open'))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  it('onToolResult is a no-op for a toolCallId we never acquired', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await onToolResult({ type: 'tool_result', toolCallId: 'never' });
    expect(called).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// worktree discipline — only the canonical staging tree is editable
// ────────────────────────────────────────────────────────────────────

describe('onToolCall worktree guard (single-tree discipline)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevCanon = process.env.PAPERCUSP_CANONICAL_TREE;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fx = await makeWorktreeFixture(); // fx.repo = <base>/papercusp (the canonical tree)
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    delete process.env.PAPERCUSP_CANONICAL_TREE; // default → <ws>/papercusp = fx.repo
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-wt';
    _resetToolCallCacheForTests();
    // Any acquire is granted, so the canonical-allow path resolves to {} (not blocked).
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, lock_id: 'L' }) }] },
        }),
    })) as unknown as typeof fetch;
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevCanon === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = prevCanon;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    await fx.cleanup();
  });

  it('denies an edit in a stray sibling worktree (e.g. papercup-staging)', async () => {
    const stray = join(fx.workspace, 'papercup-staging');
    await fs.mkdir(join(stray, '.git'), { recursive: true });
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-stray',
      input: { path: join(stray, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('worktree guard');
    expect(r.reason).toContain('canonical staging tree');
  });

  it('allows an edit in the canonical staging tree', async () => {
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-canon',
      input: { path: join(fx.repo, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBeUndefined(); // guard passes → lock granted → {}
  });

  it('allows an edit in a .papercusp/worktrees isolation tree', async () => {
    // Migration/synthesis isolation worktrees live under
    // <canonical>/.papercusp/worktrees/<name> — a non-workspace-root parent, so
    // extractLockTargets never keeps them and the guard never fires. They must
    // pass (guarding them would break those roles).
    const iso = join(fx.repo, '.papercusp', 'worktrees', 'iso-1');
    await fs.mkdir(join(iso, '.git'), { recursive: true });
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-iso',
      input: { path: join(iso, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBeUndefined(); // isolation tree → guard passes → not blocked
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking-improvements #3 — fail-open health marker
// ────────────────────────────────────────────────────────────────────

describe('recordHookSuccess / recordHookError (file-locking #3)', () => {
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-cache-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
  });
  afterEach(async () => {
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('recordHookSuccess writes last-success.json with a ts', async () => {
    const { recordHookSuccess } = await import('../coord-hook');
    await recordHookSuccess();
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-success.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    expect(Object.keys(rec)).toEqual(['ts']);
  });

  it('recordHookError writes last-error.json with the plan-spec shape', async () => {
    const { recordHookError } = await import('../coord-hook');
    await recordHookError({
      handler: 'tool_call',
      phase: 'connect',
      detail: 'down',
    });
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    expect(rec.handler).toBe('tool_call');
    expect(rec.phase).toBe('connect');
    expect(rec.detail).toBe('down');
    expect(rec.operator_url).toBe('http://operator.test');
  });

  it('creates the cache directory if missing', async () => {
    const nested = join(dir, 'deep', 'nested');
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = nested;
    const { recordHookSuccess } = await import('../coord-hook');
    await recordHookSuccess();
    expect(
      JSON.parse(await fs.readFile(join(nested, 'last-success.json'), 'utf8')),
    ).toHaveProperty('ts');
  });

  it('does not throw when the cache dir is unwritable', async () => {
    // Point the cache dir UNDER a regular file: mkdir(recursive) then
    // fails fast and deterministically with ENOTDIR, which writeMarker
    // swallows. (A /proc path is "unwritable" too but mkdir can hang on
    // it indefinitely — ENOTDIR is the clean, instant signal.)
    const asFile = join(dir, 'not-a-dir');
    await fs.writeFile(asFile, 'x');
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = join(asFile, 'cannot-write');
    const { recordHookSuccess, recordHookError } = await import('../coord-hook');
    await expect(recordHookSuccess()).resolves.toBeUndefined();
    await expect(
      recordHookError({ handler: 'tool_result', phase: 'http', detail: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('onToolCall writes the health markers (file-locking #3)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-cache-flow-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    _resetToolCallCacheForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  it('writes last-success.json on a successful acquire', async () => {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  lock_id: 'L-ok',
                  expires_ts: 't',
                  held: ['a.ts'],
                }),
              },
            ],
          },
        }),
    })) as unknown as typeof fetch;
    await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-ok',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-success.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    // No error file written on the happy path.
    await expect(
      fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('writes last-error.json (phase=connect) when the operator is unreachable', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const origErr = console.error;
    console.error = () => {};
    try {
      await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'tc-err',
        input: { path: join(repo, 'a.ts'), content: 'x' },
      });
    } finally {
      console.error = origErr;
    }
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    );
    expect(rec.handler).toBe('tool_call');
    expect(rec.phase).toBe('connect');
    expect(typeof rec.ts).toBe('string');
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking #2 audit fixes — per-process owner id, session_shutdown
// ────────────────────────────────────────────────────────────────────

describe('hookOwnerId — per-process coordination owner (file-locking #2)', () => {
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  const prevPaperSid = process.env.PAPERCUSP_SID;
  beforeEach(() => {
    // The minted-id path is the FALLBACK (only when there is no PAPERCUSP_SID); clear it so the
    // minted cases below exercise that fallback rather than the now-preferred PAPERCUSP_SID path.
    delete process.env.PAPERCUSP_SID;
    _resetHookOwnerIdForTests();
  });
  afterEach(() => {
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    if (prevPaperSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = prevPaperSid;
    _resetHookOwnerIdForTests();
  });

  it('PREFERS PAPERCUSP_SID (the psu adv-session id) so the operator resolves the workspace via the adv-row', () => {
    process.env.PAPERCUSP_SID = 'su-abc-123';
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe('su-abc-123');
  });

  it('mints omp-<session>-<pid> from PAPERCUSP_AUTH_SESSION_ID when no PAPERCUSP_SID', () => {
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-abc';
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe(`omp-pus-abc-${process.pid}`);
  });

  it('falls back to a random session part when no env session id', () => {
    delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    _resetHookOwnerIdForTests();
    const id = hookOwnerId();
    expect(id).toMatch(new RegExp(`^omp-[a-z0-9]+-${process.pid}$`));
  });

  it('is stable across calls within the process', () => {
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe(hookOwnerId());
  });

  it('always ends with the real pid (distinguishes sibling shells) in the minted fallback', () => {
    _resetHookOwnerIdForTests();
    expect(hookOwnerId().endsWith(`-${process.pid}`)).toBe(true);
  });
});

describe('callMcpTool passes ?client=<owner> (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevSuperuser = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevSuperuser === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevSuperuser;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    _resetHookOwnerIdForTests();
  });

  it('appends the minted owner as a client query param', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-xyz';
    _resetHookOwnerIdForTests();
    let seenUrl = '';
    global.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:declare-intent', { intent: 'x' });
    expect(seenUrl).toContain('power_user=1');
    expect(seenUrl).toContain(
      `client=${encodeURIComponent(`omp-pus-xyz-${process.pid}`)}`,
    );
  });

  it('falls back to the superuser MCP route for /adv engineer launches', async () => {
    delete process.env.PAPERCUSP_BUNDLE_URL;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    _resetHookOwnerIdForTests();
    let seenUrl = '';
    let auth = '';
    global.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url);
      auth = String(init?.headers?.Authorization ?? '');
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:declare-intent', { intent: 'x' });
    expect(seenUrl).toContain('superuser=1');
    expect(auth).toBe('Bearer su-token');
  });

  // Regression: @modelcontextprotocol/sdk's Streamable HTTP transport
  // frames responses as `event: message\ndata: <json>\n\n`. An earlier
  // parser only handled the case where `data:` was the first byte and
  // silently returned null on every coord call — flipping the hook into
  // `degraded` every turn and spamming the model + TUI with the
  // "coordination call failed this turn" reminder.
  it('parses SSE responses that lead with an `event: message` line', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n',
    })) as unknown as typeof fetch;
    const out = await callMcpTool('coord:inbox', {});
    expect(out).toEqual({ ok: true });
  });
});

// WI-1081: callMcpTool's fetch had NO timeout, so a slow/wedged operator (e.g. a
// bg-host restart-loop) blocked the OMP extension handler until OMP's framework
// timeout KILLED it — 30s session_start / 2s turn_start — a launch stall + an
// "Extension error: handler timed out", with no graceful degrade. callMcpTool now
// bounds every fetch with an AbortController (default 6s; turn_start passes ~1s) so
// a hung operator returns null FAST → the hook's normal degraded path.
describe('callMcpTool fetch timeout (WI-1081 — no-hang guard)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  beforeEach(() => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    _resetHookOwnerIdForTests();
  });

  it('passes an AbortSignal to fetch so a hung call can be cancelled', async () => {
    let sawSignal = false;
    global.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:inbox', {});
    expect(sawSignal).toBe(true);
  });

  it('returns null (not a hang) when the operator never responds and the timeout fires', async () => {
    // Simulate a wedged operator: fetch resolves ONLY when its AbortSignal fires.
    global.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig)
          sig.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            (e as { name: string }).name = 'AbortError';
            reject(e);
          });
        // never resolves on its own — only the abort path completes it
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await callMcpTool('coord:inbox', {}, { timeoutMs: 40 });
    const elapsed = Date.now() - started;
    expect(out).toBeNull();
    // bounded by the 40ms budget, NOT a multi-second/30s hang
    expect(elapsed).toBeLessThan(1500);
  });

  it('still returns the parsed value when the response arrives within the budget', async () => {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n',
    })) as unknown as typeof fetch;
    const out = await callMcpTool('coord:inbox', {}, { timeoutMs: 5000 });
    expect(out).toEqual({ ok: true });
  });
});

describe('linkAdvSessionFromContext — ADV row linkage', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevAdvSessionId = process.env.PAPERCUSP_ADV_SESSION_ID;

  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevAdvSessionId === undefined) delete process.env.PAPERCUSP_ADV_SESSION_ID;
    else process.env.PAPERCUSP_ADV_SESSION_ID = prevAdvSessionId;
    _resetHookOwnerIdForTests();
  });

  it('calls omp:sessions link with the current OMP session id and file path', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true,"result":"linked"}' }] },
          }),
      };
    }) as unknown as typeof fetch;

    await linkAdvSessionFromContext({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });

    expect(calls).toEqual([
      {
        name: 'omp:sessions',
        args: {
          op: 'link',
          advSessionId: 42,
          sessionId: '019ab123',
          filePath: '/home/user/.omp/agent/sessions/-repo/session.jsonl',
          cwd: '/repo',
        },
      },
    ]);
  });

  it('does nothing without a launcher-provided ADV session id', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    delete process.env.PAPERCUSP_ADV_SESSION_ID;
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;

    await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });

    expect(called).toBe(false);
  });

  it('stops retrying once the ADV link result is conflict', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    let linkCalls = 0;
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        params?: { name?: string };
      };
      if (body.params?.name === 'omp:sessions') {
        linkCalls += 1;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: '{"ok":false,"result":"conflict","error":"adv_session_already_linked_to_different_omp_session"}' },
              ],
            },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    const first = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });
    const second = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(linkCalls).toBe(1);
  });

  it('re-probes immediately on turn start when an ADV link is still missing', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    let healthChecks = 0;
    const calls: string[] = [];
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith('/api/health')) {
        healthChecks += 1;
        return { ok: healthChecks >= 2 } as Response;
      }
      const body = JSON.parse(init?.body ?? '{}') as {
        params?: { name?: string };
      };
      const name = body.params?.name ?? '';
      calls.push(name);
      const resultText =
        name === 'omp:sessions'
          ? '{"ok":true,"result":"linked"}'
          : name === 'coord:watermark'
            ? '{"watermark":{}}'
            : name === 'coord:inbox'
              ? '{"entries":[]}'
              : name === 'locks:queue'
                ? '{"active_locks":[]}'
                : name === 'coord:plan-events'
                  ? '{"events":[]}'
                  : '{"ok":true}';
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: resultText }] },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    await onSessionStart({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });
    const turn = await onTurnStart({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });

    expect(turn.mode).toBe('attached');
    expect(healthChecks).toBe(2);
    expect(calls).toContain('omp:sessions');
  });
});

describe('onSessionShutdown — defensive lock release (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    _resetToolCallCacheForTests();
  });

  it('calls locks:release with all_mine:true', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] },
          }),
      };
    }) as unknown as typeof fetch;
    await onSessionShutdown();
    // Shutdown now ALSO reports a "■ session ended" lifecycle row to the activity
    // bridge before the lock backstop — assert on the lock call specifically.
    const release = calls.find((c) => c.name === 'locks:release');
    expect(release).toBeTruthy();
    expect(release!.args).toEqual({ all_mine: true });
    const lifecycle = calls.find((c) => c.name === 'activity:report');
    expect((lifecycle!.args as { kind: string; summary: string })).toMatchObject({ kind: 'lifecycle', summary: '■ session ended' });
  });
});

describe('extractPathsFromToolInput backslash consistency (file-locking #2)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;
  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fx.cleanup();
  });

  it('skips backslash paths (the server rejects them — path-normalize.ts)', () => {
    expect(
      extractPathsFromToolInput('write', { path: `${repo}/apps\\foo.ts` }),
    ).toEqual([]);
  });

  it('still canonicalizes ./ // and trailing slash via resolve()', () => {
    expect(
      extractPathsFromToolInput('write', { path: `${repo}/./apps//foo.ts` }),
    ).toEqual(['apps/foo.ts']);
  });
});

describe('detectSymlinkedPaths / formatSymlinkRefusal (file-locking #1)', () => {
  let root: string;
  let wsBase: string;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;

  beforeEach(async () => {
    // `root` is a worktree (has .git) under a workspace base, so the
    // onToolCall test below resolves it through the same find_repo_root
    // + workspace gate as production; the direct detectSymlinkedPaths
    // tests only need `root` to be a real dir.
    wsBase = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'su-symlink-ws-')),
    );
    root = join(wsBase, 'papercup');
    await fs.mkdir(join(root, '.git'), { recursive: true });
    await fs.mkdir(join(root, 'apps'), { recursive: true });
    await fs.writeFile(join(root, 'apps', 'real.ts'), 'x');
    process.env.PAPERCUSP_WORKSPACE_ROOT = wsBase;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fs.rm(wsBase, { recursive: true, force: true });
  });

  it('passes a plain non-symlinked path', () => {
    expect(detectSymlinkedPaths(['apps/real.ts'], root)).toEqual([]);
  });

  it('passes a not-yet-existent leaf (new file via write)', () => {
    expect(detectSymlinkedPaths(['apps/brand-new.ts'], root)).toEqual([]);
  });

  it('flags a symlinked file pointing at a real repo file', async () => {
    await fs.symlink(
      join(root, 'apps', 'real.ts'),
      join(root, 'apps', 'link.ts'),
    );
    expect(detectSymlinkedPaths(['apps/link.ts'], root)).toEqual([
      { given: 'apps/link.ts', real: 'apps/real.ts' },
    ]);
  });

  it('flags a path whose directory component is a symlink', async () => {
    await fs.symlink(join(root, 'apps'), join(root, 'aliasdir'));
    expect(detectSymlinkedPaths(['aliasdir/real.ts'], root)).toEqual([
      { given: 'aliasdir/real.ts', real: 'apps/real.ts' },
    ]);
  });

  it('flags a symlink that escapes the repo entirely', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'su-outside-'));
    await fs.writeFile(join(outside, 'ext.ts'), 'x');
    await fs.symlink(
      join(outside, 'ext.ts'),
      join(root, 'apps', 'escape.ts'),
    );
    const hits = detectSymlinkedPaths(['apps/escape.ts'], root);
    expect(hits).toHaveLength(1);
    expect(hits[0].given).toBe('apps/escape.ts');
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('fails open when the root is not a real directory', () => {
    expect(
      detectSymlinkedPaths(['apps/real.ts'], '/no/such/root/here'),
    ).toEqual([]);
  });

  it('does not flag paths when the repo root itself is under a symlink', async () => {
    // A symlinked *root* must not make every path look symlinked —
    // both root and path canonicalize the same way.
    const linkRoot = join(tmpdir(), `su-rootlink-${Date.now()}-${process.pid}`);
    await fs.symlink(root, linkRoot);
    expect(detectSymlinkedPaths(['apps/real.ts'], linkRoot)).toEqual([]);
    await fs.rm(linkRoot, { force: true });
  });

  it('formatSymlinkRefusal names each aliased path and its real target', () => {
    const msg = formatSymlinkRefusal([
      { given: 'apps/link.ts', real: 'apps/real.ts' },
    ]);
    expect(msg).toMatch(/refused/i);
    expect(msg).toMatch(/symlink/i);
    expect(msg).toMatch(/apps\/link\.ts/);
    expect(msg).toMatch(/apps\/real\.ts/);
  });

  it('onToolCall blocks a symlinked target before contacting the operator', async () => {
    await fs.symlink(
      join(root, 'apps', 'real.ts'),
      join(root, 'apps', 'link.ts'),
    );
    // PAPERCUSP_WORKSPACE_ROOT is set by beforeEach so `root` resolves as
    // a coordinated worktree.
    const origFetch = global.fetch;
    let fetched = false;
    global.fetch = (async () => {
      fetched = true;
      throw new Error('should not contact operator on a symlink refusal');
    }) as unknown as typeof fetch;
    try {
      const r = await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'sym-1',
        input: { path: join(root, 'apps', 'link.ts'), content: 'x' },
      });
      expect(r.block).toBe(true);
      expect(r.reason).toMatch(/symlink/i);
      expect(fetched).toBe(false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('formatInboxDelta (mid-turn coord delivery — DUMB PIPE, P-009)', () => {
  // Formatting/capping/collapse now live server-side in coord:inbox's
  // `injection` (coord-schema.renderInjection); this hook only wraps the
  // server-rendered string in the OMP coord envelope.
  it('returns "" for an empty/blank injection', () => {
    expect(formatInboxDelta('')).toBe('');
    expect(formatInboxDelta('   \n  ')).toBe('');
  });

  it('wraps the server-rendered positional injection verbatim in a coord system-reminder', () => {
    const injection = '[coord+1]\n> peerA grabbed feature-claim.ts';
    expect(formatInboxDelta(injection)).toBe(
      `<system-reminder type="coord">\n${injection}\n</system-reminder>`,
    );
  });

  it('does not re-format, re-cap, or append a footer (the server owns all of that)', () => {
    const injection = '[coord+9]\n…+1 older\n> a x\n^ b y';
    const out = formatInboxDelta(injection);
    expect(out).toContain('[coord+9]');
    expect(out).not.toMatch(/coord:send/); // footer is in the prompt legend now
    expect(out).not.toContain('new coordination message'); // no hook-side header
  });
});

describe('pollInboxDelta (mid-turn coord delivery)', () => {
  const originalFetch = global.fetch;
  const prevOp = process.env.PAPERCUSP_OPERATOR_URL;

  // Local MCP-response mock (the onToolCall block's helper is private to it).
  const mockMcp = (payload: unknown): typeof fetch =>
    (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
    })) as unknown as typeof fetch;

  beforeEach(() => {
    _resetHookOwnerIdForTests();
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:3070';
  });
  afterEach(() => {
    _resetHookOwnerIdForTests();
    _resetMidTurnCursorForTests(undefined);
    global.fetch = originalFetch;
    if (prevOp === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOp;
  });

  it('no baseline cursor → no-op, never fetches (no history dump)', async () => {
    _resetMidTurnCursorForTests(undefined);
    let called = false;
    global.fetch = (async () => {
      called = true;
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;
    const { reminder } = await pollInboxDelta();
    expect(reminder).toBe('');
    expect(called).toBe(false);
  });

  it('injects messages newer than the cursor, then dedupes once the cursor advances', async () => {
    _resetMidTurnCursorForTests('2026-06-01T00:00:00Z');
    global.fetch = mockMcp({
      entries: [
        { ts: '2026-06-01T00:05:00Z', msg_id: 'm1', from: 'peer-X', kind: 'message', summary: 'pausing operator soon' },
      ],
      // The server pre-renders the injection (dumb-pipe contract, P-009).
      injection: '[coord+1]\n- peerX pausing operator soon',
      summary: { newest_ts: '2026-06-01T00:05:00Z' },
    });
    const first = await pollInboxDelta();
    expect(first.reminder).toContain('pausing operator soon');

    // Cursor now past m1 → a poll with nothing newer injects nothing.
    global.fetch = mockMcp({ entries: [] });
    const second = await pollInboxDelta();
    expect(second.reminder).toBe('');
  });

  it('returns "" when the operator call fails (best-effort, never throws)', async () => {
    _resetMidTurnCursorForTests('2026-06-01T00:00:00Z');
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { reminder } = await pollInboxDelta();
    expect(reminder).toBe('');
  });
});

describe('mid-turn coord delivery uses followUp, not steer (ornith-coord-inbox-flood-livelock)', () => {
  const originalFetch = global.fetch;
  const prevOp = process.env.PAPERCUSP_OPERATOR_URL;

  const mockMcp = (payload: unknown): typeof fetch =>
    (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
    })) as unknown as typeof fetch;

  beforeEach(() => {
    _resetHookOwnerIdForTests();
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:3070';
  });
  afterEach(() => {
    _resetHookOwnerIdForTests();
    _resetMidTurnCursorForTests(undefined);
    global.fetch = originalFetch;
    if (prevOp === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOp;
  });

  /**
   * Regression guard for the coord-inbox-flood LIVELOCK (fact
   * `ornith-coord-inbox-flood-livelock`, 2026-07-04). `deliverAs:'steer'`
   * routes the coord delta to omp's steering queue, which ABORTS the in-flight
   * tool ("Skipped due to queued user message"). Under a busy fleet's ambient
   * `*` broadcast flood + a slow local model, every tool is aborted before it
   * finishes → the session never makes progress. Mid-turn coord awareness must
   * therefore be delivered as `followUp` (after the tool completes), never
   * `steer`.
   */
  it('delivers the coord delta as followUp so the in-flight tool is not aborted', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ msg: { customType?: string }; opts?: { deliverAs?: string } }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { customType?: string }, opts?: { deliverAs?: string }) => {
        sent.push({ msg, opts });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);

    _resetMidTurnCursorForTests('2026-06-01T00:00:00Z');
    global.fetch = mockMcp({
      entries: [
        { ts: '2026-06-01T00:05:00Z', msg_id: 'm1', from: 'peer-X', kind: 'message', summary: 'ambient broadcast' },
      ],
      injection: '[coord+1]\n- peerX ambient broadcast',
      summary: { newest_ts: '2026-06-01T00:05:00Z' },
    });

    await subs.get('tool_result')!({ type: 'tool_result', toolCallId: 'tc-1' }, {});

    const coordMsg = sent.find((s) => s.msg.customType === 'coord-reminder');
    expect(coordMsg).toBeDefined();
    expect(coordMsg!.opts?.deliverAs).toBe('followUp');
    expect(coordMsg!.opts?.deliverAs).not.toBe('steer');
  });
});

describe('collapseDigestNotifies (coordination-substrate Phase 2, D-006)', () => {
  const notify = (over: Partial<InboxEntry>): InboxEntry => ({
    ts: '2026-06-04T00:00:00.000Z',
    msg_id: 'm',
    from: 'substrate',
    kind: 'notify',
    ...over,
  });

  it('passes full-mode notifies through untouched', () => {
    const entries = [notify({ summary: 'a', subject: 'feature:F-1' }), notify({ summary: 'b', subject: 'issue:I-1' })];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.summary)).toEqual(['a', 'b']);
  });

  it('coalesces same-subject digest notifies into one line with a count + latest summary', () => {
    const entries = [
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → validating', ts: '2026-06-04T00:00:01.000Z' }),
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → passed', ts: '2026-06-04T00:00:03.000Z' }),
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → reviewing', ts: '2026-06-04T00:00:02.000Z' }),
    ];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toContain('×3');
    expect(out[0].summary).toContain('latest: F-1 → passed'); // newest ts wins
  });

  it('keeps distinct subjects separate and leaves a lone digest as a plain line', () => {
    const entries = [
      notify({ subject: 'feature:F-1', digest: true, summary: 'one' }),
      notify({ subject: 'plan:p', digest: true, summary: 'two' }),
    ];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(2);
    expect(out.every((e) => !(e.summary ?? '').includes('×'))).toBe(true);
  });

  it('does not collapse full notifies even with the same subject', () => {
    const entries = [
      notify({ subject: 'feature:F-1', summary: 'x' }),
      notify({ subject: 'feature:F-1', summary: 'y' }),
    ];
    expect(collapseDigestNotifies(entries)).toHaveLength(2);
  });
});

describe('formatTurnStartReminder — digest notify coalescing', () => {
  it('renders coalesced digest notifies as a single ×N line', () => {
    const out = formatTurnStartReminder({
      ownerId: 'me',
      heldLocks: [],
      changedPlans: [],
      inbox: [
        { ts: '2026-06-04T00:00:01.000Z', msg_id: '1', from: 'substrate', kind: 'notify', subject: 'feature:F-1', digest: true, summary: 'F-1 a' },
        { ts: '2026-06-04T00:00:02.000Z', msg_id: '2', from: 'substrate', kind: 'notify', subject: 'feature:F-1', digest: true, summary: 'F-1 b' },
      ],
    });
    expect(out).toContain('×2');
    // one coalesced notify line, not two
    expect(out.match(/\[notify\]/g) ?? []).toHaveLength(1);
  });
});

// ── activity bridge — the OMP in-process port (papercusp-worker-integration) ──
describe('buildActivityArgs (OMP activity port)', () => {
  beforeEach(() => {
    _resetHookOwnerIdForTests();
    _resetActivityReportDedupeForTests();
  });

  it('forwards a raw tool call (server derives the summary) with agent=omp + phase=pre', () => {
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'edit', toolCallId: 'tc1', input: { path: '/repo/a.ts' } });
    expect(args).toMatchObject({ agent: 'omp', phase: 'pre', tool_name: 'edit', tool_use_id: 'tc1', tool_input: { path: '/repo/a.ts' } });
    expect(typeof args.owner).toBe('string');
    expect(String(args.owner)).toMatch(/^omp-/); // hookOwnerId shape
    expect(args).not.toHaveProperty('todos');
  });

  it('caps long string inputs + collapses arrays/objects so the report stays small', () => {
    const args = buildActivityArgs({
      type: 'tool_call', toolName: 'write', toolCallId: 'tc2',
      input: { path: '/x', content: 'y'.repeat(900), extra: [1, 2], obj: { a: 1 } },
    });
    const ti = args.tool_input as Record<string, unknown>;
    expect((ti.content as string).length).toBe(501); // 500 + ellipsis
    expect(ti.extra).toBe('[2 items]');
    expect(ti.obj).toBe('[object]');
    expect(ti.path).toBe('/x');
  });

  it('forwards a todo_write list as `todos` (uncapped, sliced) so the server summarises kind=todos', () => {
    const args = buildActivityArgs({
      type: 'tool_call', toolName: 'todo_write', toolCallId: 'tc3',
      input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
    });
    expect(args.todos).toHaveLength(2);
    expect(args).not.toHaveProperty('tool_input');
  });

  it('caps a giant todo list to 100 items', () => {
    const todos = Array.from({ length: 150 }, (_, i) => ({ content: `t${i}`, status: 'pending' }));
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'todo_write', toolCallId: 'tc4', input: { todos } });
    expect((args.todos as unknown[]).length).toBe(100);
  });

  it('a non-todo tool with no input still forwards an empty capped input', () => {
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'bash', toolCallId: 'tc5', input: {} });
    expect(args.tool_input).toEqual({});
    expect(args.tool_name).toBe('bash');
  });

  it('suppresses burst-duplicate reports for the same OMP tool call', async () => {
    const originalFetch = global.fetch;
    const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
    const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    const posts: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      posts.push((JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } }).params);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    try {
      const event = { type: 'tool_call' as const, toolName: 'ask', toolCallId: 'a', input: { questions: [] } };
      await reportActivity(event);
      await reportActivity(event);
      await reportActivity({ ...event, toolCallId: 'b' });
      expect(posts.map((p) => p.arguments.tool_use_id)).toEqual(['a', 'b']);
    } finally {
      global.fetch = originalFetch;
      if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL; else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
      if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN; else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    }
  });
});

describe('reportLifecycle (OMP session lifecycle → activity bridge)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;

  beforeEach(() => {
    _resetHookOwnerIdForTests();
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL; else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN; else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
  });

  async function capture(phase: 'start' | 'shutdown') {
    let posted: { name: string; arguments: Record<string, unknown> } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      posted = (JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } }).params;
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    await reportLifecycle(phase);
    return posted as { name: string; arguments: Record<string, unknown> } | null;
  }

  it('reports a "▶ session started" lifecycle row on start (agent=omp, kind=lifecycle)', async () => {
    const p = await capture('start');
    expect(p?.name).toBe('activity:report');
    expect(p?.arguments).toMatchObject({ agent: 'omp', kind: 'lifecycle', summary: '▶ session started' });
    expect(String(p?.arguments.owner)).toMatch(/^omp-/);
  });

  it('reports a "■ session ended" lifecycle row on shutdown', async () => {
    const p = await capture('shutdown');
    expect(p?.arguments).toMatchObject({ kind: 'lifecycle', summary: '■ session ended' });
  });
});

describe('buildObjectiveTitleOsc (OMP objective → terminal title, P-004)', () => {
  const ESC = '\x1b]0;';
  const BEL = '\x07';

  it('wraps a real objective in an OSC-0 set-title escape with the 🔭 marker', () => {
    expect(buildObjectiveTitleOsc('wire objective display')).toBe(`${ESC}🔭 wire objective display${BEL}`);
  });

  it('leads with the agent papercusp id (short su- + 5 hex) when an id is passed, objective after', () => {
    expect(buildObjectiveTitleOsc('wire the title id', 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93')).toBe(
      `${ESC}su-fcdb9 · 🔭 wire the title id${BEL}`,
    );
  });

  it('with an id but no objective, the title is just the id (the terminal always shows its owner)', () => {
    const id = 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93';
    expect(buildObjectiveTitleOsc(null, id)).toBe(`${ESC}su-fcdb9${BEL}`);
    expect(buildObjectiveTitleOsc('', id)).toBe(`${ESC}su-fcdb9${BEL}`);
  });

  it('the fallback chain absences (null / undefined / blank) all yield no escape', () => {
    expect(buildObjectiveTitleOsc(null)).toBe('');
    expect(buildObjectiveTitleOsc(undefined)).toBe('');
    expect(buildObjectiveTitleOsc('')).toBe('');
    expect(buildObjectiveTitleOsc('   ')).toBe('');
  });

  it('a non-string objective is treated as absent (fail-open against a malformed payload)', () => {
    expect(buildObjectiveTitleOsc(42 as unknown as string)).toBe('');
    expect(buildObjectiveTitleOsc({} as unknown as string)).toBe('');
  });

  it('clips a long objective with an ellipsis so it cannot overflow the title bar', () => {
    const long = 'implement the cross-CLI session objective display across every fleet client right now';
    const osc = buildObjectiveTitleOsc(long);
    expect(osc.startsWith(`${ESC}🔭 `)).toBe(true);
    expect(osc.endsWith(BEL)).toBe(true);
    expect(osc).toContain('…');
    // The title text (between the 🔭 marker and BEL) stays bounded.
    const inner = osc.slice(`${ESC}🔭 `.length, -1);
    expect([...inner].length).toBeLessThanOrEqual(60);
  });

  it('strips embedded control chars that could break out of the OSC string', () => {
    // A BEL or ESC inside the objective must not terminate / re-open the escape.
    const osc = buildObjectiveTitleOsc('evil\x07title\x1bhere');
    expect(osc).toBe(`${ESC}🔭 eviltitlehere${BEL}`);
    // Exactly one BEL (the terminator) and one ESC (the introducer).
    expect([...osc].filter((c) => c === BEL)).toHaveLength(1);
    expect([...osc].filter((c) => c === '\x1b')).toHaveLength(1);
  });
});

describe('buildDisplayTitleOsc + statusNoticeKey (single-source display pipe, 2026-07-05)', () => {
  const ESC = '\x1b]0;';
  const BEL = '\x07';

  it('wraps the server-rendered title VERBATIM — no local re-assembly', () => {
    expect(buildDisplayTitleOsc('👑 roman 🟪 · ⟳1m · su-abc12 · 🔭 wire the pipe')).toBe(
      `${ESC}👑 roman 🟪 · ⟳1m · su-abc12 · 🔭 wire the pipe${BEL}`,
    );
  });

  it('absent / blank / non-string title → no escape (falls through to the legacy render)', () => {
    expect(buildDisplayTitleOsc(null)).toBe('');
    expect(buildDisplayTitleOsc(undefined)).toBe('');
    expect(buildDisplayTitleOsc('   ')).toBe('');
    expect(buildDisplayTitleOsc(42 as unknown as string)).toBe('');
  });

  it('strips control chars that could break out of the OSC string', () => {
    const osc = buildDisplayTitleOsc('safe\x1b]0;pwn\x07 title');
    expect(osc).toBe(`${ESC}safe]0;pwn title${BEL}`);
    expect([...osc].filter((c) => c === BEL)).toHaveLength(1);
    expect([...osc].filter((c) => c === '\x1b')).toHaveLength(1);
  });

  it('statusNoticeKey: id|text, "tip" fallback id, empty when there is nothing to show', () => {
    expect(statusNoticeKey({ id: 'wake-mode-manual', text: '💡 back to auto' })).toBe('wake-mode-manual|💡 back to auto');
    expect(statusNoticeKey({ text: '💡 anon tip' })).toBe('tip|💡 anon tip');
    expect(statusNoticeKey({ id: 'x', text: '   ' })).toBe('');
    expect(statusNoticeKey(null)).toBe('');
    expect(statusNoticeKey(undefined)).toBe('');
  });
});

describe('emitStatusDisplay (OMP display pipe: title verbatim + 💡 notice on change)', () => {
  const originalFetch = global.fetch;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevToken = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_SID;
  const prevTty = process.env.PAPERCUSP_OBJECTIVE_TTY;
  let ttyFile = '';
  let payload: Record<string, unknown> = {};

  function installFetch() {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
    })) as unknown as typeof fetch;
  }

  beforeEach(async () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    process.env.PAPERCUSP_SID = 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93';
    ttyFile = join(tmpdir(), `omp-display-tty-${Math.random().toString(36).slice(2)}`);
    process.env.PAPERCUSP_OBJECTIVE_TTY = ttyFile;
    payload = { ok: true };
    _resetHookOwnerIdForTests();
    _resetStatusNoticeDedup();
    installFetch();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevToken === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = prevSid;
    if (prevTty === undefined) delete process.env.PAPERCUSP_OBJECTIVE_TTY;
    else process.env.PAPERCUSP_OBJECTIVE_TTY = prevTty;
    _resetHookOwnerIdForTests();
    _resetStatusNoticeDedup();
    await fs.rm(ttyFile, { force: true });
  });

  it('writes display.title VERBATIM as OSC-0 (display wins over a local objective)', async () => {
    payload = {
      ok: true,
      self: { objective: 'LOCAL objective (must not render)' },
      display: { title: '👑 f 🟦 · ⏸ ✉3 · su-abc12', statusline: [], notice: null },
    };
    await emitStatusDisplay();
    expect(await fs.readFile(ttyFile, 'utf8')).toBe('\x1b]0;👑 f 🟦 · ⏸ ✉3 · su-abc12\x07');
  });

  it('no display block (older operator) → the legacy objective title fallback', async () => {
    payload = { ok: true, self: { objective: 'legacy obj' } };
    await emitStatusDisplay();
    expect(await fs.readFile(ttyFile, 'utf8')).toBe(
      buildObjectiveTitleOsc('legacy obj', process.env.PAPERCUSP_SID),
    );
  });

  it('delivers a NEW notice to the model + human, DEDUPES repeats, re-emits on CHANGE', async () => {
    const sent: Array<{ customType: string; content: string }> = [];
    const notes: Array<{ m: string; t?: string }> = [];
    const pi = { sendMessage: (m: { customType: string; content: string }) => { sent.push(m); } };
    const ctx = { hasUI: true, ui: { notify: (m: string, t?: string) => { notes.push({ m, t }); } } };
    payload = {
      ok: true,
      display: { title: 'su-abc12', statusline: [], notice: { id: 'wake-mode-manual', text: '💡 back to auto: coord:wake-mode mode=auto' } },
    };
    await emitStatusDisplay(pi as never, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].customType).toBe('papercusp-status-tip');
    expect(sent[0].content).toContain('papercusp-status-tip');
    expect(sent[0].content).toContain('💡 back to auto: coord:wake-mode mode=auto');
    expect(sent[0].content).toContain('coord:glance for detail');
    expect(notes).toEqual([{ m: '💡 back to auto: coord:wake-mode mode=auto', t: 'info' }]);
    // Same notice again → deduped (no spam on every turn).
    await emitStatusDisplay(pi as never, ctx);
    expect(sent).toHaveLength(1);
    expect(notes).toHaveLength(1);
    // A CHANGED notice re-emits.
    payload = {
      ok: true,
      display: { title: 'su-abc12', statusline: [], notice: { id: 'governor-paused', text: '💡 governor paused' } },
    };
    await emitStatusDisplay(pi as never, ctx);
    expect(sent).toHaveLength(2);
    expect(sent[1].content).toContain('governor paused');
  });

  it('no notice → nothing sent, no ui.notify (title leg still runs)', async () => {
    const sent: unknown[] = [];
    const pi = { sendMessage: (m: unknown) => { sent.push(m); } };
    payload = { ok: true, display: { title: 'su-abc12', statusline: [], notice: null } };
    await emitStatusDisplay(pi as never, { hasUI: false });
    expect(sent).toHaveLength(0);
    expect(await fs.readFile(ttyFile, 'utf8')).toBe('\x1b]0;su-abc12\x07');
  });

  it('a ui-less ctx (headless omp) still injects the model-facing notice', async () => {
    const sent: Array<{ content: string }> = [];
    const pi = { sendMessage: (m: { content: string }) => { sent.push(m); } };
    payload = { ok: true, display: { title: null, statusline: [], notice: { id: 't', text: '💡 headless tip' } } };
    await emitStatusDisplay(pi as never, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('headless tip');
  });
});

describe('resolveHookWorkspace (robust workspace resolution)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE;
  const prevHome = process.env.PAPERCUSP_HOME;
  afterEach(() => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE; else process.env.PAPERCUSP_WORKSPACE = prevWs;
    if (prevHome === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = prevHome;
  });
  it('prefers PAPERCUSP_WORKSPACE when set', () => {
    process.env.PAPERCUSP_WORKSPACE = 'ws-env';
    process.env.PAPERCUSP_HOME = '/home/u/.papercusp-workspaces/ws-path/.papercusp';
    expect(resolveHookWorkspace()).toBe('ws-env');
  });
  it('derives the workspace from the .papercusp-workspaces/<ws>/ session path when no env var', () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    process.env.PAPERCUSP_HOME = '/home/u/.papercusp-workspaces/papercusp-workspace/.papercusp';
    expect(resolveHookWorkspace()).toBe('papercusp-workspace');
  });
  it('returns a string (empty) when neither env nor a workspace path is present', () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    process.env.PAPERCUSP_HOME = '/home/u/not/a/workspace';
    expect(typeof resolveHookWorkspace()).toBe('string');
  });
});

describe('callMcpTool workspace scoping (scoped-superuser clamp fix)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE;
  let headers: Record<string, string> = {};
  beforeEach(() => {
    headers = {};
    global.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }),
      };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE;
    else process.env.PAPERCUSP_WORKSPACE = prevWs;
  });

  it('sends x-papercusp-workspace from PAPERCUSP_WORKSPACE so the superuser clamp resolves the call', async () => {
    process.env.PAPERCUSP_WORKSPACE = 'papercusp-workspace';
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x' });
    expect(headers['x-papercusp-workspace']).toBe('papercusp-workspace');
  });

  it('honors an explicit workspace override', async () => {
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x', workspace: 'ws-override' });
    expect(headers['x-papercusp-workspace']).toBe('ws-override');
  });

  it('omits the header when no workspace is resolvable (no worse than before)', async () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x', workspace: '' });
    expect(headers['x-papercusp-workspace']).toBeUndefined();
  });
});

// ── search_tool_bm25 off-ramp closure (weak-model-tool-tier-2026-07-01 / ornith) ──────────────
// The trimmed surface gives a weak/local model tools:find + tools:invoke as its ONLY discovery
// path; onToolCall blocks OMP's native search_tool_bm25 for agent sessions and redirects to
// tools:find. These cover the pure pieces (the I/O redirect buildToolFindRedirect is verified at
// deploy against a live operator, per this file's header).

describe('isNativeToolSearch', () => {
  it('matches OMP native search_tool_bm25 case-insensitively', () => {
    expect(isNativeToolSearch('search_tool_bm25')).toBe(true);
    expect(isNativeToolSearch('SEARCH_TOOL_BM25')).toBe(true);
  });
  it('does not match our discovery tools or anything else', () => {
    expect(isNativeToolSearch('tools:find')).toBe(false);
    expect(isNativeToolSearch('tools:invoke')).toBe(false);
    expect(isNativeToolSearch('coord:send')).toBe(false);
    expect(isNativeToolSearch('bash')).toBe(false);
    expect(isNativeToolSearch('search')).toBe(false);
  });
});

describe('extractToolSearchQuery', () => {
  it('reads the canonical query field (trimmed)', () => {
    expect(extractToolSearchQuery({ query: '  feature flags  ' })).toBe('feature flags');
  });
  it('tolerates the alternate field names OMP might use', () => {
    expect(extractToolSearchQuery({ keyword: 'spawn a worker' })).toBe('spawn a worker');
    expect(extractToolSearchQuery({ q: 'locks' })).toBe('locks');
  });
  it('falls back to the first non-empty string value for an unknown field', () => {
    expect(extractToolSearchQuery({ somethingElse: 'send message' })).toBe('send message');
  });
  it('returns empty string when there is no usable query', () => {
    expect(extractToolSearchQuery({})).toBe('');
    expect(extractToolSearchQuery(undefined)).toBe('');
    expect(extractToolSearchQuery({ query: '   ' })).toBe('');
    expect(extractToolSearchQuery({ limit: 5 })).toBe('');
  });
});

describe('formatToolFindRedirect', () => {
  it('renders the tools:find matches inline as the suggestion (first description line only)', () => {
    const reason = formatToolFindRedirect('spawn a worker', [
      { tool: 'cup:spawn', description: 'Spawn one agent of a role into a harness.\nMore detail.' },
      { tool: 'work_items:claim_next', description: 'Claim the oldest unclaimed work-item.' },
    ]);
    expect(reason).toContain('search_tool_bm25 is disabled');
    expect(reason).toContain('tools:find');
    expect(reason).toContain('• cup:spawn — Spawn one agent of a role into a harness.');
    expect(reason).toContain('• work_items:claim_next');
    expect(reason).toContain('tools:invoke');
    // first line of the description only — never the whole multi-line schema dump
    expect(reason).not.toContain('More detail.');
  });
  it('degrades to a plain instruction when tools:find returned no matches', () => {
    const reason = formatToolFindRedirect('nonsense zzz', []);
    expect(reason).toContain('no matches');
    expect(reason).toContain('tools:find');
    expect(reason).not.toContain('•');
  });
  it('handles a missing query without crashing (still redirects)', () => {
    const reason = formatToolFindRedirect('', [{ tool: 'x' }]);
    expect(reason).toContain('search_tool_bm25 is disabled');
    expect(reason).toContain('tools:find("<what you need>")');
    expect(reason).not.toContain('• x');
  });
  it('skips hits with no tool name', () => {
    const reason = formatToolFindRedirect('q', [{ description: 'no name' }, { tool: 'coord:send' }]);
    expect(reason).toContain('• coord:send');
    expect(reason).not.toContain('no name');
  });
});
