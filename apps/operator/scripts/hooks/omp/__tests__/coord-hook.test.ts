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
  extractPathsFromToolInput,
  formatBusyRefusal,
  formatTurnStartReminder,
  onToolCall,
  onToolResult,
  readInboxFs,
  readPlanEventsFs,
  readWatermarkFs,
  summarisePlanEvents,
  writeWatermarkFs,
  _resetToolCallCacheForTests,
  type InboxEntry,
} from '../coord-hook';

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

  it('operator unreachable → detached mode, not a degraded warning (F-H4)', async () => {
    // No operator configured in the unit-test env (no PAPERCUSP_*_URL),
    // so probeOperator() → false → the turn resolves to DETACHED mode.
    // Detached is a supported mode, not a failure: the reminder carries
    // the detached header and NO warning notification fires.
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
    // The reminder must carry the detached header.
    const detachedMsg = sent.find(
      (s) => typeof s.content === 'string' && s.content.includes('DETACHED'),
    );
    expect(detachedMsg).toBeTruthy();
    // Detached is not an error — no warning notification.
    expect(notifications.length).toBe(0);
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

describe('detached filesystem reads (F-H4c)', () => {
  let tmp = '';
  let prev: string | undefined;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'coord-hook-fs-'));
    prev = process.env.PAPERCUSP_COORD_DIR;
    process.env.PAPERCUSP_COORD_DIR = tmp;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env.PAPERCUSP_COORD_DIR;
    else process.env.PAPERCUSP_COORD_DIR = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('readInboxFs returns entries addressed to the owner, excludes own + others', async () => {
    await fs.mkdir(join(tmp, 'messages'), { recursive: true });
    // peer 'B' wrote a line to 'me' and one to 'C'.
    await fs.writeFile(
      join(tmp, 'messages', 'B.jsonl'),
      [
        JSON.stringify({ ts: '2026-05-20T01:00:00Z', msg_id: 'm1', from: 'B', to: ['me'], kind: 'message', summary: 'hi me' }),
        JSON.stringify({ ts: '2026-05-20T02:00:00Z', msg_id: 'm2', from: 'B', to: ['C'], kind: 'message', summary: 'hi C' }),
        JSON.stringify({ ts: '2026-05-20T03:00:00Z', msg_id: 'm3', from: 'B', to: ['*'], kind: 'message', summary: 'broadcast' }),
      ].join('\n') + '\n',
    );
    // my own outbox — must be excluded.
    await fs.writeFile(
      join(tmp, 'messages', 'me.jsonl'),
      JSON.stringify({ ts: '2026-05-20T04:00:00Z', msg_id: 'm4', from: 'me', to: ['*'], kind: 'message', summary: 'mine' }) + '\n',
    );
    const inbox = await readInboxFs('me');
    expect(inbox.map((e) => e.msg_id)).toEqual(['m1', 'm3']);
  });

  it('readInboxFs honours the since_ts watermark', async () => {
    await fs.mkdir(join(tmp, 'messages'), { recursive: true });
    await fs.writeFile(
      join(tmp, 'messages', 'B.jsonl'),
      [
        JSON.stringify({ ts: '2026-05-20T01:00:00Z', msg_id: 'old', from: 'B', to: ['me'], kind: 'message' }),
        JSON.stringify({ ts: '2026-05-20T05:00:00Z', msg_id: 'new', from: 'B', to: ['me'], kind: 'message' }),
      ].join('\n') + '\n',
    );
    const inbox = await readInboxFs('me', '2026-05-20T03:00:00Z');
    expect(inbox.map((e) => e.msg_id)).toEqual(['new']);
  });

  it('readInboxFs returns [] when coord/messages is absent', async () => {
    expect(await readInboxFs('me')).toEqual([]);
  });

  it('watermark round-trips through the filesystem (both pointers)', async () => {
    expect(await readWatermarkFs('me')).toEqual({});
    await writeWatermarkFs('me', { messages: '2026-05-20T10:00:00Z' });
    expect((await readWatermarkFs('me')).messages).toBe('2026-05-20T10:00:00Z');
    // a second write to messages overwrites; plan_events is independent.
    await writeWatermarkFs('me', { messages: '2026-05-20T11:00:00Z' });
    expect((await readWatermarkFs('me')).messages).toBe('2026-05-20T11:00:00Z');
    // writing only plan_events leaves messages intact (partial merge).
    await writeWatermarkFs('me', { plan_events: '2026-05-20T12:00:00Z' });
    const wm = await readWatermarkFs('me');
    expect(wm.messages).toBe('2026-05-20T11:00:00Z');
    expect(wm.plan_events).toBe('2026-05-20T12:00:00Z');
  });

  it('readPlanEventsFs scans plan-events files, honours since_ts (NB-2)', async () => {
    // legacy un-suffixed file + a monthly file.
    await fs.writeFile(
      join(tmp, 'plan-events.jsonl'),
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', msg_id: 'a', from: 's', kind: 'plan_event', plan_slug: 'p-old', event: 'created' }) + '\n',
    );
    await fs.writeFile(
      join(tmp, 'plan-events-2026-05.jsonl'),
      [
        JSON.stringify({ ts: '2026-05-10T00:00:00Z', msg_id: 'b', from: 's', kind: 'plan_event', plan_slug: 'p-may', event: 'now_updated' }),
        // a non-plan_event line in the same file must be ignored.
        JSON.stringify({ ts: '2026-05-11T00:00:00Z', msg_id: 'c', from: 's', kind: 'message' }),
      ].join('\n') + '\n',
    );
    const all = await readPlanEventsFs();
    expect(all.map((e) => e.msg_id)).toEqual(['a', 'b']);
    expect(all.every((e) => e.kind === 'plan_event')).toBe(true);
    // since_ts filters out the old event.
    const recent = await readPlanEventsFs('2026-03-01T00:00:00Z');
    expect(recent.map((e) => e.plan_slug)).toEqual(['p-may']);
  });

  it('readPlanEventsFs feeds summarisePlanEvents end to end', async () => {
    await fs.writeFile(
      join(tmp, 'plan-events-2026-05.jsonl'),
      [
        JSON.stringify({ ts: '2026-05-10T00:00:00Z', msg_id: 'b', from: 's', kind: 'plan_event', plan_slug: 'p1', event: 'created' }),
        JSON.stringify({ ts: '2026-05-11T00:00:00Z', msg_id: 'c', from: 's', kind: 'plan_event', plan_slug: 'p1', event: 'promoted' }),
      ].join('\n') + '\n',
    );
    const summary = summarisePlanEvents(await readPlanEventsFs());
    expect(summary).toEqual([{ plan_slug: 'p1', events: ['created', 'promoted'] }]);
  });

  it('readPlanEventsFs returns [] when no plan-events files exist', async () => {
    expect(await readPlanEventsFs()).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking-improvements #2 — onToolCall / onToolResult enforcement
// ────────────────────────────────────────────────────────────────────

describe('extractPathsFromToolInput (file-locking #2)', () => {
  const prevRoot = process.env.PAPERCUSP_REPO_ROOT;
  beforeEach(() => {
    process.env.PAPERCUSP_REPO_ROOT = '/repo';
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
    else process.env.PAPERCUSP_REPO_ROOT = prevRoot;
  });

  it('claims `path` from a write tool input', () => {
    expect(extractPathsFromToolInput('write', { path: '/repo/a.ts' })).toEqual([
      'a.ts',
    ]);
  });

  it('accepts path | file_path | filePath for edit', () => {
    expect(
      extractPathsFromToolInput('edit', { path: '/repo/a.ts' }),
    ).toEqual(['a.ts']);
    expect(
      extractPathsFromToolInput('edit', { file_path: '/repo/b.ts' }),
    ).toEqual(['b.ts']);
    expect(
      extractPathsFromToolInput('edit', { filePath: '/repo/c.ts' }),
    ).toEqual(['c.ts']);
  });

  it('claims every literal path from ast_edit, drops globs', () => {
    expect(
      extractPathsFromToolInput('ast_edit', {
        paths: ['/repo/a.ts', '/repo/dir/*.ts', '/repo/b.ts', '/repo/x?.ts'],
        ops: [],
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('drops paths outside the repo root', () => {
    expect(
      extractPathsFromToolInput('write', { path: '/etc/passwd' }),
    ).toEqual([]);
    expect(
      extractPathsFromToolInput('write', { path: '/repo' }),
    ).toEqual([]);
  });

  it('returns [] for non-file-editing tools', () => {
    expect(extractPathsFromToolInput('bash', { command: 'ls' })).toEqual([]);
    expect(extractPathsFromToolInput('read', { path: '/repo/a.ts' })).toEqual([]);
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
  const prevRoot = process.env.PAPERCUSP_REPO_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;

  beforeEach(() => {
    process.env.PAPERCUSP_REPO_ROOT = '/repo';
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-test';
    _resetToolCallCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevRoot === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
    else process.env.PAPERCUSP_REPO_ROOT = prevRoot;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
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

  it('returns {} when the tool has no claimable path', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      throw new Error('should not call');
    }) as unknown as typeof fetch;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 't1',
      input: { command: 'ls' },
    });
    expect(r).toEqual({});
    expect(called).toBe(false);
  });

  it('caches lock_id on ok and releases on tool_result', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload =
        body.params.name === 'coord:locks:acquire'
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
      input: { path: '/repo/a.ts', content: 'x' },
    });
    expect(r).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('coord:locks:acquire');

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(calls).toHaveLength(2);
    expect(calls[1].name).toBe('coord:locks:release');
    expect((calls[1].args as { lock_id: string }).lock_id).toBe('L-1');

    // Second release on the same toolCallId is a no-op (cache cleared).
    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(calls).toHaveLength(2);
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
      input: { path: '/repo/a.ts', content: 'x' },
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
        input: { path: '/repo/a.ts', content: 'x' },
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

describe('recordHookHealth (file-locking #3)', () => {
  const prevPath = process.env.PAPERCUSP_HOOK_HEALTH_PATH;
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'su-hook-health-'));
    path = join(dir, 'hook-health.json');
    process.env.PAPERCUSP_HOOK_HEALTH_PATH = path;
  });
  afterEach(async () => {
    if (prevPath === undefined) delete process.env.PAPERCUSP_HOOK_HEALTH_PATH;
    else process.env.PAPERCUSP_HOOK_HEALTH_PATH = prevPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes a JSON marker and merges with existing fields', async () => {
    const { recordHookHealth } = await import('../coord-hook');
    await recordHookHealth({ last_ok_ts: '2026-05-20T10:00:00Z' });
    let raw = await fs.readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ last_ok_ts: '2026-05-20T10:00:00Z' });
    await recordHookHealth({
      last_error_ts: '2026-05-20T10:01:00Z',
      last_error_kind: 'operator_unreachable',
      last_error_message: 'down',
    });
    raw = await fs.readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({
      last_ok_ts: '2026-05-20T10:00:00Z',
      last_error_ts: '2026-05-20T10:01:00Z',
      last_error_kind: 'operator_unreachable',
      last_error_message: 'down',
    });
  });

  it('creates the parent directory if missing', async () => {
    const nested = join(dir, 'deep', 'nested', 'hook-health.json');
    process.env.PAPERCUSP_HOOK_HEALTH_PATH = nested;
    const { recordHookHealth } = await import('../coord-hook');
    await recordHookHealth({ last_ok_ts: 't' });
    expect(JSON.parse(await fs.readFile(nested, 'utf8'))).toEqual({
      last_ok_ts: 't',
    });
  });

  it('does not throw when the path is unwritable', async () => {
    process.env.PAPERCUSP_HOOK_HEALTH_PATH = '/proc/1/cannot-write.json';
    const { recordHookHealth } = await import('../coord-hook');
    await expect(recordHookHealth({ last_ok_ts: 't' })).resolves.toBeUndefined();
  });
});

describe('onToolCall writes the health marker (file-locking #3)', () => {
  const originalFetch = global.fetch;
  const prevRoot = process.env.PAPERCUSP_REPO_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevHealth = process.env.PAPERCUSP_HOOK_HEALTH_PATH;
  let dir: string;
  let healthPath: string;

  beforeEach(async () => {
    process.env.PAPERCUSP_REPO_ROOT = '/repo';
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    dir = await fs.mkdtemp(join(tmpdir(), 'su-hook-health-flow-'));
    healthPath = join(dir, 'hook-health.json');
    process.env.PAPERCUSP_HOOK_HEALTH_PATH = healthPath;
    _resetToolCallCacheForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevRoot === undefined) delete process.env.PAPERCUSP_REPO_ROOT;
    else process.env.PAPERCUSP_REPO_ROOT = prevRoot;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevHealth === undefined) delete process.env.PAPERCUSP_HOOK_HEALTH_PATH;
    else process.env.PAPERCUSP_HOOK_HEALTH_PATH = prevHealth;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('records last_ok_ts on a successful acquire', async () => {
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
      input: { path: '/repo/a.ts', content: 'x' },
    });
    const rec = JSON.parse(await fs.readFile(healthPath, 'utf8'));
    expect(typeof rec.last_ok_ts).toBe('string');
    expect(rec.last_error_ts).toBeUndefined();
  });

  it('records last_error_ts when the operator is unreachable', async () => {
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
        input: { path: '/repo/a.ts', content: 'x' },
      });
    } finally {
      console.error = origErr;
    }
    const rec = JSON.parse(await fs.readFile(healthPath, 'utf8'));
    expect(typeof rec.last_error_ts).toBe('string');
    expect(rec.last_error_kind).toBe('operator_unreachable');
  });
});
