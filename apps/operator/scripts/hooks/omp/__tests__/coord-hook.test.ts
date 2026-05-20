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
  formatTurnStartReminder,
  readInboxFs,
  readWatermarkFs,
  summarisePlanEvents,
  writeWatermarkFs,
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
      'turn_end',
      'turn_start',
    ]);
    // tool_call handler permits all by default (stub).
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

  it('watermark round-trips through the filesystem', async () => {
    expect(await readWatermarkFs('me')).toBeUndefined();
    await writeWatermarkFs('me', '2026-05-20T10:00:00Z');
    expect(await readWatermarkFs('me')).toBe('2026-05-20T10:00:00Z');
    // a second write overwrites.
    await writeWatermarkFs('me', '2026-05-20T11:00:00Z');
    expect(await readWatermarkFs('me')).toBe('2026-05-20T11:00:00Z');
  });
});
