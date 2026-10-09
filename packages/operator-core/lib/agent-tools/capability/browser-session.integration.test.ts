/** Real Chromium + real task ledger, isolated PostgreSQL; no operator or fleet mutation. */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../capability-envelope/session-confinement-store', () => ({
  ensureSessionConfinementsReady: async () => {}, sessionConfinementFor: () => null,
}));
// Trusted flag defaults are fixture-local. The real policy still forces confined callers on.
vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));

import { runBrowserSession } from './browser-session';
import { capabilityBwrapWorks } from './exec-sandbox';
import { getTask } from '../../task-manager/store';
import { readProcessIdentity } from '../../process-identity';
import { setAutoPumpEnabledForTests } from '../../events/await/engine';
import { taskTerminalEventKey } from '../../task-manager/task-terminal-events';

describe('managed browser process enrollment and loss (real PG/Chromium)', () => {
  let db: OrgTestDb; let server: Server; let base = '';
  const handles: Array<{ id: string; ctx: UnifiedToolContext }> = [];
  const context = (suffix: string, confined = false) => ({
    workspaceId: 'browser-ledger-workspace', uiClientId: `browser-ledger-${suffix}`,
    harnessSlug: 'papercusp', role: 'operator', isSuperuser: !confined, sigVerifiedSpawn: confined,
    signal: new AbortController().signal, log: vi.fn(),
  }) as unknown as UnifiedToolContext;
  async function call(args: Parameters<typeof runBrowserSession>[0], ctx: UnifiedToolContext, url?: string) {
    const result = await runBrowserSession(args, url, ctx, { timeoutMs: 20_000, maxText: 1000 });
    return { result, body: JSON.parse(result.content[0].text!) };
  }
  async function open(ctx: UnifiedToolContext) {
    const opened = await call({ op: 'open', selector: '#ready', screenshot: true }, ctx, base);
    if (opened.body.ok) handles.push({ id: opened.body.browser.id, ctx });
    return opened;
  }
  beforeAll(async () => {
    db = await createOrgTestDb(); h.sql = db.adminSql;
    // Preserve real terminal-event persistence; host delivery is outside this
    // private fixture and must not race database teardown.
    setAutoPumpEnabledForTests(false);
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>enrolled browser</title></head><body><p id="ready">real managed page</p></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('TCP fixture required');
    base = `http://127.0.0.1:${address.port}/`;
  }, 60_000);
  afterAll(async () => {
    for (const handle of handles) await call({ op: 'close', id: handle.id }, handle.ctx);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await db?.cleanup();
  });
  it('enrolls exact workspace/owner/kernel identity and closes the real row and directory', async () => {
    const ctx = context('trusted'); const { body, result } = await open(ctx);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(result.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const row = (await getTask(body.browser.task_id))!;
    expect(row).toMatchObject({ class: 'browser', state: 'running', workspaceId: ctx.workspaceId,
      launchedBy: ctx.uiClientId, sessionId: ctx.uiClientId, harnessSlug: 'papercusp',
      detail: { browserSessionId: body.browser.id } });
    expect(row.processIdentity).toBe(readProcessIdentity(row.pid!));
    expect(row.processIdentity).toBeTruthy(); expect(existsSync(row.cwd!)).toBe(true);
    expect((await call({ op: 'close', id: body.browser.id }, context('foreign'))).body.ok).toBe(false);
    expect((await getTask(row.taskId))!.state).toBe('running');
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('closed');
    // The reply must await closeTask's terminal bridge, not merely its earlier UPDATE.
    const [fire] = await h.sql`SELECT fire_count FROM harness_shared.event_key_fires
      WHERE event_key = ${taskTerminalEventKey(row.taskId)}`;
    expect(Number(fire?.fire_count)).toBe(1);
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
    expect(existsSync(row.cwd!)).toBe(false); expect(readProcessIdentity(row.pid!)).toBeNull();
  }, 30_000);
  it('cleans unexpected real Chromium death without claiming recoverable page state', async () => {
    const ctx = context('lost'); const { body } = await open(ctx);
    expect(body.ok, JSON.stringify(body)).toBe(true);
    const row = (await getTask(body.browser.task_id))!;
    expect(readProcessIdentity(row.pid!)).toBe(row.processIdentity);
    process.kill(row.pid!, 'SIGKILL'); // Exact freshly enrolled test child only.
    await vi.waitFor(() => expect(existsSync(row.cwd!)).toBe(false), { timeout: 5000 });
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
    expect((await call({ op: 'observe', id: body.browser.id }, ctx)).body).toMatchObject({
      ok: false, error: 'browser_unrecoverable', browser: { state: 'lost', reason: 'browser-process-ended' },
    });
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('lost');
    expect(readProcessIdentity(row.pid!)).toBeNull();
  }, 30_000);
  it(capabilityBwrapWorks()
    ? 'forces real bwrap network confinement for verified autonomous callers'
    : 'refuses unavailable OS confinement before autonomous process enrollment', async () => {
    // Confined HTTP intentionally refuses loopback targets. Open about:blank to
    // measure OS containment independently of the fixture server's trusted URL.
    const ctx = context('confined', true); const { body } = await call({ op: 'open' }, ctx);
    if (body.ok) handles.push({ id: body.browser.id, ctx });
    if (!capabilityBwrapWorks()) {
      expect(body).toMatchObject({ ok: false, error: 'capability_exec_confinement_unavailable' });
      const rows = await h.sql`SELECT task_id FROM harness_shared.task_ledger WHERE launched_by = ${ctx.uiClientId!}`;
      expect(rows).toHaveLength(0); return;
    }
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.browser.sandbox).toMatchObject({ mode: 'bwrap', sandboxed: true });
    const row = (await getTask(body.browser.task_id))!;
    const args = row.argv as string[];
    expect(args).toContain('--unshare-net'); expect(args).toContain('--ro-bind');
    // launchServer.process() is bwrap's host-side supervisor, whose namespace
    // is not Chromium's. Follow only this freshly enrolled child's descendants.
    const pending = [row.pid!]; let browserPid: number | undefined;
    while (pending.length) {
      const pid = pending.pop()!;
      try {
        const executable = readlinkSync(`/proc/${pid}/exe`);
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (/\/(chrome|chrome-headless-shell)$/.test(executable) && !argv.includes('--type=')) {
          browserPid = pid; break;
        }
        pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number));
      } catch { /* A short-lived intermediate child may have exited. */ }
    }
    expect(browserPid, 'live Chromium must exist under the enrolled supervisor').toBeDefined();
    const hostNet = readFileSync('/proc/self/net/dev', 'utf8');
    const childNet = readFileSync(`/proc/${browserPid}/net/dev`, 'utf8');
    expect(childNet.trim().split('\n')).toHaveLength(3);
    expect(hostNet.trim().split('\n').length).toBeGreaterThan(3);
    expect(body.observation.url).toBe('about:blank');
    expect((await call({ op: 'close', id: body.browser.id }, ctx)).body.browser.state).toBe('closed');
    await vi.waitFor(async () => expect((await getTask(row.taskId))!.state).toBe('exited'), { timeout: 5000 });
  }, 30_000);
});
