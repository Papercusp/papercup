/**
 * GET /api/operator/state-snapshot
 *
 * SSE stream of state-channel snapshots for the active workspace.
 * Chat surfaces subscribe to this stream to render openCards as they
 * appear (ctx.askUser flow). The stream emits both an initial dump of
 * every currently-open run AND live updates as tools mutate state.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md
 * (consumer companion to PR 1's server-side infrastructure)
 *
 * Auth: session cookie required (401 if missing).
 *
 * SSE events:
 *   - snapshot: { runId, version, snapshot: { openCards, toolState } }
 *     — fired both for initial state and live updates. Client merges
 *     by runId; later versions supersede earlier ones for the same
 *     runId.
 */

import { sseResponse } from '@restart/sse';

import {
  snapshotWorkspace,
  subscribeWorkspace,
  type VersionedSnapshot,
} from '@papercusp/agent-mcp';

import { getSessionUser } from '@/lib/auth';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface StateSnapshotVocabulary {
  snapshot: VersionedSnapshot;
}

export async function GET(req: Request): Promise<Response> {
  const user = await getSessionUser();
  if (!user) {
    return new Response('unauthorized', { status: 401 });
  }
  const workspaceId = activeWorkspaceId();

  return sseResponse<StateSnapshotVocabulary>({
    signal: req.signal,
    heartbeatMs: 15_000,
    initialHeartbeat: true,
    setup: async (sink) => {
      // Initial dump — every open run in the workspace.
      for (const vs of snapshotWorkspace(workspaceId)) {
        if (sink.closed) return;
        sink.event('snapshot', vs);
      }
      // Live updates.
      const off = subscribeWorkspace(workspaceId, (vs) => {
        if (sink.closed) return;
        sink.event('snapshot', vs);
      });
      sink.onClose(off);
    },
  });
}
