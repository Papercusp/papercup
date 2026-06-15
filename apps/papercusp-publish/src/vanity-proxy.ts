/**
 * Wildcard route handler for *.preview.papercuspai.com.
 *
 * Looks up projects.vanity_subdomain, reverse-proxies to the project's
 * auto-generated CF Pages subdomain. Hides the *.pages.dev URL.
 */

import type { Env } from './env.ts';
import { getProjectByVanity } from './db.ts';

export async function handleVanity(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const host = url.hostname;
  const vanityHost = env.VANITY_HOST;
  // Only `<subdomain>.<vanityHost>` is a valid vanity address. The apex host
  // itself has no subdomain — and the slice below would mis-derive one from it
  // (`slice(0, -1)` drops the last char rather than yielding ''), so reject it
  // here before any DB lookup rather than relying on the empty-string guard.
  if (!host.endsWith('.' + vanityHost)) {
    return new Response('not found', { status: 404 });
  }
  const subdomain = host.slice(0, host.length - vanityHost.length - 1);
  if (!subdomain) return new Response('not found', { status: 404 });

  const project = await getProjectByVanity(env.DB, subdomain);
  if (!project || !project.cf_subdomain) {
    return new Response('not found', { status: 404 });
  }

  const target = new URL(url.pathname + url.search, `https://${project.cf_subdomain}`);
  const upstream = await fetch(target.toString(), {
    method: req.method,
    headers: stripHopByHop(req.headers),
    body:
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : (req.body as ReadableStream | null),
    redirect: 'manual',
    // @ts-expect-error workerd accepts duplex
    duplex: 'half',
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: upstream.headers,
  });
}

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const h of [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'transfer-encoding',
    'upgrade',
    'host',
  ]) {
    out.delete(h);
  }
  return out;
}
