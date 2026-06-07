/**
 * GET /api/deploy/:slug/frame-view → text/event-stream
 *
 * SSE stream of a deployed frame's per-display desktop thumbnails — the Swarm
 * live-view transport (`hive-frame-desktops-live-view-2026-06-06` P-005/P-006,
 * D-003): the operator pulls JPEGs from the frame over SSH ONLY while ≥1 of
 * these streams is open, and fans out here. Events:
 *   `thumb`  — { slug, display, jpegBase64, capturedAtMs, role?, leaseSinceMs? }
 *   `status` — { slug, state: polling|no-frame|error, frameId?, host?, displays?, error? }
 *
 * `auth: 'public'` + inline session check (the state-snapshot SSE pattern).
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';
import { getSessionUser } from '../../../auth';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  subscribeFrameView,
  type FrameThumb,
  type FrameViewStatus,
} from '../../../deployment/frame-view';

type FrameViewVocabulary = {
  thumb: FrameThumb;
  status: FrameViewStatus;
};

export default defineTool({
  method: 'GET',
  path: '/deploy/:slug/frame-view',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; don't sample it.
  sampleRate: 0,
  async handler(req, ctx) {
    const user = await getSessionUser(req.headers);
    if (!user) {
      return new Response('unauthorized', { status: 401 });
    }
    const slug = ctx.params.slug as string;
    const workspaceId = activeWorkspaceId();

    return sseResponse<FrameViewVocabulary>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: (sink) => {
        const off = subscribeFrameView(slug, workspaceId, {
          onThumb: (t) => {
            if (!sink.closed) sink.event('thumb', t);
          },
          onStatus: (s) => {
            if (!sink.closed) sink.event('status', s);
          },
        });
        sink.onClose(off);
      },
    });
  },
});
