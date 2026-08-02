/**
 * The delivery half of stale-prompt-render-in-live-sessions-2026-08-02 P-004.
 *
 * Every dependency is injected, so these run with no /proc, no DB and no coord: the
 * things worth pinning here are the ORDERING and the FAIL-CLOSED behaviour, not the IO.
 * Specifically — the debounce slot must be claimed BEFORE the notify (a crash mid-delivery
 * must not re-page forever), an incomplete source union must stand the route family down
 * rather than page the whole fleet, and a session whose render is unreadable must not take
 * the sweep down with it.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  formatStaleRenderAlert,
  listLiveSessionRenders,
  readCurrentPersonaSources,
  staleRenderFireKey,
  staleRenderFireReason,
  stalePromptRenderSweep,
  type LiveSessionRender,
} from './stale-prompt-render-sweep';
import { detectMaterialRenderDrift } from './prompt-material-signals';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_RENDER = 'use the `Task` (Agent) tool to fan out parallel or context-isolated work.';
const CLEAN_RENDER = '⛔ `Task` / `Workflow` are DENIED — never reach for them; use a fleet.';

function session(over: Partial<LiveSessionRender> = {}): LiveSessionRender {
  return {
    ownerId: 'su-aaa',
    pid: 1234,
    promptFile: '/tmp/session-1.md',
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    ...over,
  };
}

function deps(over: Parameters<typeof stalePromptRenderSweep>[0] = {}) {
  return {
    listLiveSessionRenders: () => [session()],
    readCurrentPersonaSources: async () => ({ texts: ['# sources'], complete: true }),
    readRender: () => ({ text: STALE_RENDER, mtime: '2026-07-19T00:00:00.000Z' }),
    claimWatchdogFire: vi.fn(async () => true),
    sendMessage: vi.fn(async () => ({}) as never),
    ...over,
  };
}

describe('stalePromptRenderSweep', () => {
  it('notifies the affected agent ITSELF, once, with the drift in the body', async () => {
    const d = deps();
    const res = await stalePromptRenderSweep(d);
    expect(res.outcomes).toEqual([
      expect.objectContaining({ ownerId: 'su-aaa', outcome: 'notified' }),
    ]);
    expect(d.sendMessage).toHaveBeenCalledTimes(1);
    const [, opts] = (d.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.to).toEqual(['su-aaa']);
    expect(opts.summary).toContain('Task');
    expect(opts.body).toContain('/tmp/session-1.md');
  });

  it('claims the debounce slot BEFORE sending — a crash mid-delivery must not re-page forever', async () => {
    const order: string[] = [];
    const d = deps({
      claimWatchdogFire: vi.fn(async () => {
        order.push('claim');
        return true;
      }),
      sendMessage: vi.fn(async () => {
        order.push('send');
        return {} as never;
      }),
    });
    await stalePromptRenderSweep(d);
    expect(order).toEqual(['claim', 'send']);
  });

  it('does not send when the debounce slot is already held', async () => {
    const d = deps({ claimWatchdogFire: vi.fn(async () => false) });
    const res = await stalePromptRenderSweep(d);
    expect(res.outcomes[0].outcome).toBe('debounced');
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('embeds the scope key VERBATIM in the fire reason (the LIKE contract)', async () => {
    const d = deps();
    await stalePromptRenderSweep(d);
    const [{ scopeKey, reason }] = (d.claimWatchdogFire as ReturnType<typeof vi.fn>).mock.calls[0];
    // recentWatchdogFires matches `reason LIKE '%scopeKey%'` — a reason that does not
    // contain the key makes the debounce structurally dead, which is exactly how the
    // sibling sweep paged 113 times in 37 minutes (EI-18824142520274965).
    expect(reason).toContain(scopeKey);
  });

  it('says nothing about a session whose render matches current sources', async () => {
    const d = deps({ readRender: () => ({ text: CLEAN_RENDER, mtime: null }) });
    const res = await stalePromptRenderSweep(d);
    expect(res.outcomes[0].outcome).toBe('clean');
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('stands the route family down when the source union is INCOMPLETE', async () => {
    // A live prompt-override read that failed leaves a union missing whatever the
    // store holds — every mechanism in a render would then look retired, which is
    // the one way this detector could page the entire fleet about nothing.
    const d = deps({
      readCurrentPersonaSources: async () => ({
        texts: [],
        complete: false,
        reason: 'override read failed',
      }),
      readRender: () => ({ text: '1. **(0) do it** — `plans:launch`', mtime: null }),
    });
    const res = await stalePromptRenderSweep(d);
    expect(res.routeFamilySuppressed).toBe(true);
    expect(res.suppressionReason).toBe('override read failed');
    expect(res.outcomes[0].outcome).toBe('clean');
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('still reports the deny family while the route family is stood down', async () => {
    // Family 1 is reference-free, so a broken source read must not silence it too.
    const d = deps({
      readCurrentPersonaSources: async () => ({ texts: [], complete: false, reason: 'nope' }),
    });
    const res = await stalePromptRenderSweep(d);
    expect(res.outcomes[0].outcome).toBe('notified');
  });

  it('survives an unreadable render and a send failure without losing the other sessions', async () => {
    const d = deps({
      listLiveSessionRenders: () => [
        session({ ownerId: 'su-gone', promptFile: '/tmp/vanished.md' }),
        session({ ownerId: 'su-boom', promptFile: '/tmp/b.md' }),
        session({ ownerId: 'su-ok', promptFile: '/tmp/c.md' }),
      ],
      readRender: (p: string) => {
        if (p === '/tmp/vanished.md') throw new Error('ENOENT');
        return { text: STALE_RENDER, mtime: null };
      },
      sendMessage: vi.fn(async (_id: unknown, o: { to: string[] }) => {
        if (o.to[0] === 'su-boom') throw new Error('coord down');
        return {} as never;
      }) as never,
    });
    const res = await stalePromptRenderSweep(d);
    expect(res.outcomes.map((o) => [o.ownerId, o.outcome])).toEqual([
      ['su-gone', 'unreadable'],
      ['su-boom', 'error'],
      ['su-ok', 'notified'],
    ]);
  });

  it('is a no-op when nothing is running', async () => {
    const d = deps({ listLiveSessionRenders: () => [] });
    const res = await stalePromptRenderSweep(d);
    expect(res).toEqual({ outcomes: [], examined: 0, routeFamilySuppressed: false });
    expect(d.sendMessage).not.toHaveBeenCalled();
  });

  it('passes every distinct (workspace, harness) scope to the source read, deduped', async () => {
    const read = vi.fn(async () => ({ texts: ['x'], complete: true }));
    await stalePromptRenderSweep(
      deps({
        listLiveSessionRenders: () => [
          session({ ownerId: 'a' }),
          session({ ownerId: 'b' }),
          session({ ownerId: 'c', harnessSlug: 'other' }),
          session({ ownerId: 'd', harnessSlug: null }),
        ],
        readCurrentPersonaSources: read as never,
      }),
    );
    expect(read.mock.calls[0][0]).toEqual({
      scopes: [
        { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
        { workspaceId: 'papercusp-workspace', harnessSlug: 'other' },
      ],
    });
  });
});

describe('listLiveSessionRenders', () => {
  /** A fake /proc: <pid>/cmdline and <pid>/environ, both NUL-delimited. */
  function fakeProc(procs: Array<{ pid: number; argv: string[]; env: Record<string, string> }>): string {
    const root = mkdtempSync(join(tmpdir(), 'proc-'));
    for (const p of procs) {
      const d = join(root, String(p.pid));
      mkdirSync(d);
      writeFileSync(join(d, 'cmdline'), `${p.argv.join('\0')}\0`);
      writeFileSync(
        join(d, 'environ'),
        `${Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\0')}\0`,
      );
    }
    // A non-numeric entry must be ignored, like the real /proc's `self`, `net`, …
    mkdirSync(join(root, 'self'));
    return root;
  }

  it('reads the render off the LIVE argv and the ownerId off the environ', () => {
    const root = fakeProc([
      {
        pid: 42,
        argv: ['claude', '--settings', 'x', '--system-prompt-file', '/lc/session-9.md'],
        env: {
          PAPERCUSP_SID: 'su-abc',
          PAPERCUSP_WORKSPACE: 'papercusp-workspace',
          PAPERCUSP_HARNESS_SLUG: 'papercusp',
        },
      },
    ]);
    expect(listLiveSessionRenders(root)).toEqual([
      {
        ownerId: 'su-abc',
        pid: 42,
        promptFile: '/lc/session-9.md',
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
      },
    ]);
  });

  it('skips processes with no prompt file and processes with no coord identity', () => {
    const root = fakeProc([
      { pid: 1, argv: ['node', 'server.mjs'], env: { PAPERCUSP_SID: 'su-x' } },
      // a hand-run claude with a prompt file but no session identity: nobody to notify
      { pid: 2, argv: ['claude', '--system-prompt-file', '/tmp/x.md'], env: { HOME: '/root' } },
    ]);
    expect(listLiveSessionRenders(root)).toEqual([]);
  });

  it('returns [] where /proc does not exist rather than throwing', () => {
    expect(listLiveSessionRenders('/definitely/not/a/proc')).toEqual([]);
  });
});

describe('readCurrentPersonaSources', () => {
  it('marks the union INCOMPLETE when a live override read throws', async () => {
    const u = await readCurrentPersonaSources({
      promptsDir: null,
      basePersonaPath: null,
      scopes: [{ workspaceId: 'w', harnessSlug: 'h' }],
      getPromptOverride: async () => {
        throw new Error('pg down');
      },
    });
    expect(u.complete).toBe(false);
    expect(u.reason).toContain('pg down');
  });

  it('folds a live pot-instance override into the union', async () => {
    const u = await readCurrentPersonaSources({
      promptsDir: null,
      basePersonaPath: null,
      scopes: [{ workspaceId: 'w', harnessSlug: 'h' }],
      getPromptOverride: async () => null,
      potHomeSlugForHarness: async () => 'papercusp',
      getHiveInstancePromptOverride: async () => 'STORE ONLY OVERRIDE',
    });
    expect(u.complete).toBe(true);
    expect(u.texts).toContain('STORE ONLY OVERRIDE');
  });

  it('is INCOMPLETE (not empty-and-confident) when nothing at all could be read', async () => {
    const u = await readCurrentPersonaSources({ promptsDir: null, basePersonaPath: null });
    expect(u).toEqual({
      texts: [],
      complete: false,
      reason: 'no persona sources could be read',
    });
  });
});

describe('formatStaleRenderAlert', () => {
  const drift = detectMaterialRenderDrift({
    renderText: STALE_RENDER,
    sourceTexts: [],
    denied: new Set(['Task']),
  });

  it('names the drift and says plainly that it cannot be fixed in place', () => {
    const { summary, body } = formatStaleRenderAlert({
      drift,
      promptFile: '/lc/session-14416.md',
      renderedAt: '2026-07-19T12:00:00.000Z',
    });
    expect(summary).toContain('Task');
    expect(body).toContain('/lc/session-14416.md');
    expect(body).toContain('2026-07-19T12:00:00.000Z');
    // The remedy must not be a fabricated one: re-reading the file is impossible.
    expect(body).toMatch(/read once when the process/i);
  });

  it('keys the debounce on (owner, drift) and repeats the key in the reason', () => {
    const key = staleRenderFireKey('su-abc', drift);
    expect(key).toContain('su-abc');
    expect(staleRenderFireReason(key, 'summary text')).toContain(key);
  });
});
