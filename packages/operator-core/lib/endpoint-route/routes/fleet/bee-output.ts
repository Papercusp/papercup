/**
 * GET /api/fleet/bee-output — the live raw output of a RUNNING fleet bee
 * (pui-dock-agent-stack-2026-06-07: the watch pane's "what is it thinking"
 * feed).
 *
 * A bee spawned via `fleet:spawn` streams its agent stdout to
 * `<project>/.papercusp/logs/<run_id>.out` while it runs (invoke-once removes
 * it after completion, persisting only the 2KB `output_tail` on the nursery
 * row). This route resolves the bee by its coord owner (`session_owner` —
 * the `s-…` spawnId baked into its MCP client id), locates the live log, and
 * returns the bytes APPENDED since `offset` — an offset-cursor tail.
 *
 * Why offset-poll and not SSE: the source is a local file with no NOTIFY
 * rail; exactly one consumer (the bee's watch pane) polls it on a slow tick.
 * An fs.watch→SSE bridge buys nothing here but moving parts.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveProject } from '../../../harness-core';
import { requireLoopbackOr403 } from '../../loopback-guard';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
/** Max bytes returned per poll — a busy agent can't flood the pane. */
const MAX_CHUNK = 64 * 1024;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default defineTool({
  method: 'GET',
  path: '/fleet/bee-output',
  auth: 'public',
  // Polled ~every 2s by an open watch pane — keep it out of route telemetry.
  sampleRate: 0,
  async handler(req) {
    // Loopback-only (security review 2026-06-07): a bee's live stdout can carry
    // anything the agent printed — work content, paths, even secrets it echoed.
    // The ONLY consumer is the local pui watch pane, so gate like the other
    // owner-level fleet routes (harness spawn/launch) instead of serving the
    // box's agent output to any network caller who can guess an `s-…` owner id.
    const gate = requireLoopbackOr403(req);
    if (gate) return gate;
    const u = new URL(req.url);
    const owner = u.searchParams.get('owner')?.trim();
    if (!owner) return json({ error: 'missing owner' }, 400);
    const offset = Math.max(0, Number(u.searchParams.get('offset') ?? '0') || 0);

    // The newest RUNNING spawn for this coord owner (one bee = one live spawn).
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT spawn_id, workspace_id, harness_slug, run_id, status
      FROM harness_shared.spawned_agents
      WHERE session_owner = ${owner}
      ORDER BY started_at DESC
      LIMIT 1
    `) as Array<{
      spawn_id: string;
      workspace_id: string;
      harness_slug: string;
      run_id: string;
      status: string;
    }>;
    const spawn = rows[0];
    if (!spawn) return json({ status: 'unknown', offset, chunk: '' });

    const project = (await resolveProject(spawn.harness_slug, spawn.workspace_id))
      ?? (await resolveProject(spawn.harness_slug));
    if (!project) return json({ status: spawn.status, offset, chunk: '' });

    // run_id is operator-minted (opspawn-<ts>-<hex>) but belt-and-suspenders
    // against path traversal anyway.
    if (!/^[A-Za-z0-9._-]+$/.test(spawn.run_id)) {
      return json({ error: 'bad run id' }, 500);
    }
    const file = join(project.path, '.papercusp', 'logs', `${spawn.run_id}.out`);
    if (!existsSync(file)) {
      // Finished (file reaped) or not yet created — the caller shows the
      // nursery tail / waits for the next poll.
      return json({ status: spawn.status, offset, chunk: '' });
    }

    const size = statSync(file).size;
    // A restarted/truncated file: reset the cursor rather than reading air.
    const from = offset > size ? 0 : offset;
    const want = Math.min(size - from, MAX_CHUNK);
    if (want <= 0) return json({ status: spawn.status, offset: from, chunk: '' });

    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(want);
      const read = readSync(fd, buf, 0, want, from);
      return json({
        status: spawn.status,
        offset: from + read,
        chunk: buf.subarray(0, read).toString('utf8'),
      });
    } finally {
      closeSync(fd);
    }
  },
});
