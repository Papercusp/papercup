/**
 * Mobile harness routes — Phase E4 batch M4 (endpoint-unification-2026-05-21).
 * Ported off `_hono/mobile.ts`.
 *
 *   GET  /mobile/harnesses                      mobile JWT
 *   GET  /mobile/harnesses/:slug                mobile JWT
 *   POST /mobile/harnesses/:slug/replan         mobile JWT
 *   POST /mobile/harnesses/:slug/smoke-test     mobile JWT
 *   POST /mobile/harnesses/:slug/cleanup        mobile JWT
 *   GET  /mobile/harnesses/:slug/log/stream     mobile JWT (SSE)
 *   GET  /mobile/running                        mobile JWT
 */
import { join } from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { sseResponse } from '@restart/sse';
import { defineRoute } from '../../define-route';
import { MOBILE_AUTH, mobilePrincipal } from './_shared';
import { listHarnessesFor, harnessExistsInWorkspace } from '@/lib/mobile-harnesses';
import { currentlyRunning } from '@/lib/mobile-feeds';
import { phasePhaseLabel } from '@/lib/harness-phases';
import { resolvePhasedProject, harnessDir } from '@/app/api/_hono/harness';

/**
 * Proxy a mobile harness mutation to the desktop's own
 * `/api/harness/:slug/*` endpoint. The slug is verified to exist in the
 * phone's paired workspace first; the action runs against the desktop's
 * active workspace (matching workspace_id is required for the desktop
 * endpoint to find the slug — a mismatch surfaces as the proxied 404).
 */
async function shimHarnessAction(
  workspaceId: string,
  slug: string,
  path: string,
  body: unknown = {},
): Promise<Response> {
  if (!(await harnessExistsInWorkspace(workspaceId, slug))) {
    return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
  }
  const base = process.env.MOBILE_SELF_BASE ?? `http://localhost:${process.env.PORT ?? 3055}`;
  const res = await fetch(`${base}/api/harness/${encodeURIComponent(slug)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

/** GET /mobile/harnesses — every harness in the device's workspace. */
const harnessesList = defineRoute({
  method: 'GET',
  path: '/mobile/harnesses',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    const harnesses = await listHarnessesFor(mobilePrincipal(ctx).workspaceId);
    return Response.json({ harnesses });
  },
});

/**
 * GET /mobile/harnesses/:slug — per-harness status. Same shape as the
 * desktop `/api/harness/:slug/status` so the Rust client + desktop see
 * identical fields.
 */
const harnessDetail = defineRoute({
  method: 'GET',
  path: '/mobile/harnesses/:slug',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    const principal = mobilePrincipal(ctx);
    const slug = ctx.params.slug;
    if (!(await harnessExistsInWorkspace(principal.workspaceId, slug))) {
      return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
    }
    const { getHarnessStatusFull } = await import('@/app/api/_hono/harness');
    const status = await getHarnessStatusFull(slug, undefined);
    if (!status) return Response.json({ error: 'harness_not_found' }, { status: 404 });
    return Response.json(status);
  },
});

const harnessReplan = defineRoute({
  method: 'POST',
  path: '/mobile/harnesses/:slug/replan',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(req, ctx) {
    const body = await req.json().catch(() => ({}));
    return shimHarnessAction(mobilePrincipal(ctx).workspaceId, ctx.params.slug, '/replan', body);
  },
});

const harnessSmokeTest = defineRoute({
  method: 'POST',
  path: '/mobile/harnesses/:slug/smoke-test',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    return shimHarnessAction(mobilePrincipal(ctx).workspaceId, ctx.params.slug, '/smoke-test/run');
  },
});

const harnessCleanup = defineRoute({
  method: 'POST',
  path: '/mobile/harnesses/:slug/cleanup',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    return shimHarnessAction(mobilePrincipal(ctx).workspaceId, ctx.params.slug, '/cleanup');
  },
});

/**
 * GET /mobile/harnesses/:slug/log/stream — SSE. Mirrors the desktop
 * `/api/harness/:slug/log/stream` (events: log / backfill-done) but
 * gated on the mobile JWT. Workspace check enforced; `?phase=` override.
 */
const harnessLogStream = defineRoute({
  method: 'GET',
  path: '/mobile/harnesses/:slug/log/stream',
  auth: MOBILE_AUTH,
  mobile: true,
  // Pure transport — don't flood route_invocations with one row per
  // long-lived SSE connection.
  sampleRate: 0,
  async handler(req, ctx) {
    const principal = mobilePrincipal(ctx);
    const slug = ctx.params.slug;
    if (!(await harnessExistsInWorkspace(principal.workspaceId, slug))) {
      return Response.json({ error: 'harness_not_in_workspace' }, { status: 404 });
    }
    const url = new URL(req.url);
    const project = await resolvePhasedProject(slug, phasePhaseLabel(url.searchParams.get('phase') ?? undefined));
    if (!project) return Response.json({ error: 'unknown project' }, { status: 404 });
    const jsonlPath = join(harnessDir(project), 'logs', 'run.log.jsonl');
    const tailSize = Math.min(
      Math.max(parseInt(url.searchParams.get('tail') ?? '500', 10) || 500, 1),
      5000,
    );

    return sseResponse({
      signal: req.signal,
      heartbeatMs: 15_000,
      setup: async (sink) => {
        // Backfill: read the last 1 MiB of jsonl, replay up to tailSize
        // valid lines as `event: log`, then `event: backfill-done`.
        try {
          const stat = statSync(jsonlPath);
          const tailBytes = 1024 * 1024;
          const start = Math.max(0, stat.size - tailBytes);
          const len = stat.size - start;
          const buf = Buffer.alloc(len);
          const fd = openSync(jsonlPath, 'r');
          try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
          let chunk = buf.toString('utf8');
          if (start > 0) {
            const firstNl = chunk.indexOf('\n');
            if (firstNl >= 0) chunk = chunk.slice(firstNl + 1);
          }
          const allLines = chunk.split('\n').filter(Boolean);
          const toReplay = allLines.slice(-tailSize);
          let count = 0;
          for (const raw of toReplay) {
            if (sink.closed) break;
            try { JSON.parse(raw); } catch { continue; }
            sink.eventRaw('log', raw);
            count++;
          }
          sink.eventRaw('backfill-done', String(count));
        } catch {
          sink.eventRaw('backfill-done', '0');
        }

        // Live updates via the in-process log bus.
        const { subscribe: logSubscribe } = await import('@/lib/harness-log-bus');
        const sub = logSubscribe(`${project.slug}:log`, (env) => {
          if (sink.closed) return;
          try { JSON.parse(env.line); } catch { return; }
          sink.eventRaw('log', env.line);
        });
        for (const env of sub.recent) {
          if (sink.closed) break;
          try { JSON.parse(env.line); } catch { continue; }
          sink.eventRaw('log', env.line);
        }
        sink.onClose(() => sub.unsubscribe());
      },
    });
  },
});

/** GET /mobile/running — active operator scan + active harness phases. */
const running = defineRoute({
  method: 'GET',
  path: '/mobile/running',
  auth: MOBILE_AUTH,
  mobile: true,
  async handler(_req, ctx) {
    return Response.json(await currentlyRunning(mobilePrincipal(ctx).workspaceId));
  },
});

export default [
  harnessesList,
  harnessDetail,
  harnessReplan,
  harnessSmokeTest,
  harnessCleanup,
  harnessLogStream,
  running,
];
