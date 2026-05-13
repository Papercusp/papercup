/**
 * GET /api/scratch/<workspace>/<toolName>/<runId>/<basename>
 *
 * Serves a scratch file emitted by a tool's `outputRef`. Phase 4 T2.3.
 *
 * Path traversal is rejected at three layers:
 *   1. The URL itself goes through `parseScratchUri` — strict regex
 *      on each segment (UUID runId, separator-bearing toolName,
 *      basename `[A-Za-z0-9._-]+`).
 *   2. `safeScratchFilesystemPath` runs path.resolve + containment
 *      assertion against the workspace's scratch root.
 *   3. Workspace check: the requested workspace MUST match the
 *      operator's active workspace. Cross-workspace reads fail 403.
 *      (Signed-URL cross-workspace sharing is explicitly out of
 *      scope; revisit when org-sharing becomes a feature.)
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T2.3.
 */

import { NextRequest } from 'next/server';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import {
  parseScratchUri,
  safeScratchFilesystemPath,
  ScratchUriError,
  SCRATCH_SCHEME,
} from '@/lib/scratch-uri';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  // URL shape: /api/scratch/<workspace>/<toolName>/<runId>/<basename>
  // Reconstruct the scratch:// URI from the URL path.
  const rest = url.pathname.replace(/^\/api\/scratch\//, '');
  const uri = `${SCRATCH_SCHEME}/${rest}`;

  let parts;
  try {
    parts = parseScratchUri(uri);
  } catch (err) {
    return json400(err instanceof ScratchUriError ? err.message : 'invalid scratch URI');
  }

  // Workspace-locked: only the active workspace can read its own
  // scratch. Cross-workspace reads fail 403.
  const ws = activeWorkspaceId();
  if (parts.workspaceId !== ws) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'forbidden_cross_workspace',
          message: `scratch URI references workspace "${parts.workspaceId}"; operator's active workspace is "${ws}"`,
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
  }

  let fsPath: string;
  try {
    fsPath = safeScratchFilesystemPath(uri);
  } catch (err) {
    return json400(err instanceof ScratchUriError ? err.message : 'invalid scratch path');
  }

  if (!existsSync(fsPath)) {
    return new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'scratch file does not exist' } }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    );
  }

  const st = statSync(fsPath);
  if (!st.isFile()) {
    return new Response(
      JSON.stringify({ error: { code: 'not_a_file', message: 'scratch path is not a regular file' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  // Stream the file. Use Node's createReadStream + the WHATWG
  // ReadableStream conversion so we don't buffer in memory.
  const nodeStream = createReadStream(fsPath);
  // Node 18+: Readable.toWeb gives us a WHATWG ReadableStream.
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;
  return new Response(webStream, {
    status: 200,
    headers: {
      'content-type': guessContentType(parts.basename),
      'content-length': String(st.size),
      // Disable shared caching — scratch URIs are per-run, but the
      // basename is reusable across runs and we don't want a proxy
      // to confuse them.
      'cache-control': 'private, no-store',
      // round-11 audit bug #27: scratch is tool-authored content; a
      // tool writing <script>...</script> to scratch.html shouldn't
      // execute when the URL is opened in the operator browser. Force
      // download semantics + disable MIME-sniffing rescue so the
      // browser never inlines + executes scratch content.
      'content-disposition': `attachment; filename="${parts.basename}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}

function json400(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: 'bad_request', message } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * Cheap extension-based content-type guess. We intentionally don't
 * sniff the file's magic bytes — the consumer drives the
 * interpretation. Defaults to application/octet-stream.
 *
 * round-11 audit bug #27: Active-content types (text/html, image/svg+xml)
 * are deliberately downgraded to text/plain / application/octet-stream
 * because scratch is tool-authored user-controlled bytes. A response of
 * `attachment` + nosniff (set in the route) prevents inline execution
 * for the common case; downgrading the content-type is defense-in-depth.
 */
function guessContentType(basename: string): string {
  const ext = basename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'json': return 'application/json';
    case 'csv': return 'text/csv';
    case 'txt': return 'text/plain';
    case 'log': return 'text/plain';
    case 'md': return 'text/plain';   // markdown: don't render — text/plain
    case 'html': return 'text/plain'; // never serve user-controlled HTML
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'application/octet-stream'; // SVG can carry script — never inline
    case 'pdf': return 'application/pdf';
    case 'zip': return 'application/zip';
    case 'gz': return 'application/gzip';
    default: return 'application/octet-stream';
  }
}
