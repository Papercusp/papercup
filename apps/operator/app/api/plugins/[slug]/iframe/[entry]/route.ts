/**
 * GET /api/plugins/:slug/iframe/:entry?install=&nonce= — operator-templated
 * iframe document for plugin iframe surfaces (Batch H2).
 *
 * Reads the plugin's iframeEntry HTML from disk, wraps it in an
 * operator <head> that:
 *   - Sets a strict CSP (default-src 'self'; script-src 'self'
 *     'nonce-<nonce>'; connect-src 'self'; frame-ancestors 'self')
 *   - Embeds the per-iframe nonce as <meta name="papercup-nonce">
 *     for the iframe SDK to read
 *   - Injects @papercusp/plugin-sdk/iframe as a <script> with the
 *     nonce attribute matching CSP
 *
 * Security posture (rev3 A2):
 *   - sandbox attribute on the parent iframe denies allow-same-origin
 *     so the document gets a unique opaque origin.
 *   - The wrapper HTML rejects external scripts via CSP. Plugin
 *     authors stage their assets under their plugin dir.
 */
import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { getPluginHost } from '@/lib/plugin-host-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteParams { params: Promise<{ slug: string; entry: string }> }

export async function GET(req: Request, ctx: RouteParams): Promise<Response> {
  const { slug, entry } = await ctx.params;
  const url = new URL(req.url);
  const nonce = url.searchParams.get('nonce') ?? '';

  // Resolve the plugin's on-disk dir + iframeEntry.
  const state = await getPluginHost();
  const lp = state.loaded.find((p) => p.plugin.name === slug);
  if (!lp) return new NextResponse('plugin not found', { status: 404 });

  // Path traversal guard — entry must resolve under plugin dir.
  const entryAbs = resolve(lp.path, normalize(entry));
  if (!entryAbs.startsWith(lp.path + '/')) {
    return new NextResponse('iframe entry outside plugin dir', { status: 400 });
  }
  let inner: string;
  try {
    inner = await readFile(entryAbs, 'utf8');
  } catch {
    return new NextResponse('iframe entry not readable', { status: 404 });
  }

  // Templated wrapper. Body inserts the plugin's HTML inline. CSP +
  // nonce make script-src strict.
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'">
    <meta name="papercup-nonce" content="${nonce}">
    <meta name="papercup-plugin" content="${slug}">
  </head>
  <body>
${inner}
  </body>
</html>
`;

  return new NextResponse(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    },
  });
}
