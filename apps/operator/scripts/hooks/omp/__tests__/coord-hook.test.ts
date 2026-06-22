/**
 * Unit tests for the OMP coord hook's pure helpers — formatting only.
 * The HTTP / handler-registration paths are integration concerns,
 * verified at deploy against a live OMP runtime.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildActivityArgs,
  buildObjectiveTitleOsc,
  callMcpTool,
  collapseDigestNotifies,
  detectSymlinkedPaths,
  reportLifecycle,
  extractPathsFromToolInput,
  formatBusyRefusal,
  formatInboxDelta,
  formatSymlinkRefusal,
  formatTurnStartReminder,
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
  type InboxEntry,
} from '../coord-hook';

// ── native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010) ─────

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
    expect(r.reason).toContain('hive:declare-wake');
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
  const repo = join(base, 'papercup');
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
  afterEach(() => {
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    _resetHookOwnerIdForTests();
  });

  it('mints omp-<session>-<pid> from PAPERCUSP_AUTH_SESSION_ID', () => {
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

  it('always ends with the real pid (distinguishes sibling shells)', () => {
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
  beforeEach(() => _resetHookOwnerIdForTests());

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
