import { NextResponse, type NextRequest } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';

/*
 * Next 16 renamed `middleware.ts` → `proxy.ts` and the exported
 * `middleware` function → `proxy`. Keeping the old names triggers a
 * deprecation warning AND breaks `next build` page-data collection
 * (Cannot find module .next/server/middleware-manifest.json) because
 * Next 16 emits proxy-* manifests but its build pipeline still
 * looks up middleware-manifest.json by string.
 *
 * This single proxy handles two concerns:
 *  1. /internal/docs/* — stub auth gate (loopback-only docs).
 *  2. /docs/* — Accept-header content negotiation. When the client
 *     requests `text/markdown`, rewrite to the /llms.mdx surface
 *     (which runs the agent doc pipeline in lib/get-llm-text.ts)
 *     instead of the HTML render. Lets curl/agents consume the same
 *     content as /llms.mdx/<slug> without learning a separate URL.
 */

const docsToMarkdown = rewritePath('/docs{/*path}', '/llms.mdx{/*path}');

const AGENT_MCP_CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, if-match, last-event-id, x-requested-with',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Max-Age': '600',
} as const;

function allowedAgentMcpOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1):(1420|3055|3070)$/.test(origin)) return origin;
  return null;
}

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  const origin = req.headers.get('origin');
  const corsOrigin = pathname.startsWith('/api/agent-mcp/')
    ? allowedAgentMcpOrigin(origin)
    : null;
  if (corsOrigin) {
    const headers = new Headers({
      'Access-Control-Allow-Origin': corsOrigin,
      ...AGENT_MCP_CORS_HEADERS,
    });
    headers.append('Vary', 'Origin');
    headers.append('Vary', 'Access-Control-Request-Headers');
    if (req.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers });
    }
    const response = NextResponse.next();
    headers.forEach((value, key) => response.headers.set(key, value));
    return response;
  }

  // 1. /internal/docs/* — auth gate. Order matters: gate before any
  //    other rewrite so the markdown negotiation can't bypass it.
  if (pathname.startsWith('/internal/docs')) {
    if (process.env.PAPERCUSP_INTERNAL_DOCS_BYPASS === '1') {
      return NextResponse.next();
    }
    return new NextResponse(
      'Internal docs are gated. Set PAPERCUSP_INTERNAL_DOCS_BYPASS=1 to bypass during development.',
      { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  // 2. /docs/* with Accept: text/markdown → /llms.mdx/<slug>.
  if (pathname.startsWith('/docs/') && isMarkdownPreferred(req)) {
    const rewritten = docsToMarkdown.rewrite(pathname);
    if (rewritten) {
      return NextResponse.rewrite(new URL(rewritten, req.nextUrl));
    }
  }

  return NextResponse.next();
}

export const config = {
  // The matcher must include every path the proxy() function might
  // act on. /internal/docs gating + /docs Accept-header negotiation +
  // credentialed CORS for standalone /api/agent-mcp/* route handlers.
  matcher: ['/api/agent-mcp/:path*', '/internal/docs/:path*', '/docs/:path*'],
};
