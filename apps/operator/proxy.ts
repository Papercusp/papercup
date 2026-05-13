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

export function proxy(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

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
  // act on. /internal/docs gating + /docs Accept-header negotiation.
  matcher: ['/internal/docs/:path*', '/docs/:path*'],
};
