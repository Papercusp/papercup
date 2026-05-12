/**
 * GET /drizzle-studio
 *
 * Fetches the Drizzle Studio SPA HTML from local.drizzle.studio and injects
 * a `<base href="/drizzle-studio/">` so the SPA's relative asset URLs
 * (`./index.js`, `./favicon.svg`) resolve under our origin instead of the
 * document root. Without this, the iframe loads a blank document — the
 * `<script src="./index.js">` ends up at /index.js (not /drizzle-studio/index.js),
 * which our Next server 404s.
 *
 * The /drizzle-studio/:path* rewrite in next.config.js then proxies those
 * asset requests transparently through to the CDN.
 *
 * Why proxy at all: Drizzle Studio's SPA on https://local.drizzle.studio
 * tries to fetch http://localhost:<port> for the local gateway. Chrome's
 * Private Network Access blocks that (public HTTPS → private localhost).
 * Serving the SPA same-origin (http://localhost:3055/drizzle-studio) makes
 * those fetches localhost→localhost, which is allowed.
 *
 * Mirrors apps/web/app/drizzle-studio/route.ts in the Restart repo.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let html: string;
  try {
    const res = await fetch('https://local.drizzle.studio/', {
      next: { revalidate: 3600 },
    });
    html = await res.text();
  } catch {
    return new Response(
      '<!doctype html><html><body style="font-family:monospace;padding:2rem">' +
      '<h2>Could not fetch Drizzle Studio SPA</h2>' +
      '<p>Check network connectivity to <code>local.drizzle.studio</code>.</p>' +
      '</body></html>',
      { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }

  const patched = html.replace(
    '<head>',
    '<head><base href="/drizzle-studio/">',
  );

  return new Response(patched, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'SAMEORIGIN',
    },
  });
}
