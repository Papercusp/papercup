// Public read-only Papercup API.
//
// Whitelists what's safe to expose to the public site (apps/public-site).
// All endpoints are GET-only; the route mount in [[...route]]/route.ts permits
// only GET methods on this prefix.
//
// Strategy: read from the same internal /api/harness/* sources the admin UI
// uses, but project the result into a sanitized shape — no internal IDs, no
// PII, no tokens, no full message bodies that might contain secrets.

import { Hono } from 'hono';
import { tmpdir } from 'node:os';
import { capLog, capBody, scrub, scrubFreeText } from './public-sanitize';
import { runAgentChat } from '@papercusp/papercusp-shared/agent';

export const publicPapercup = new Hono();

const INTERNAL_BASE = process.env.INTERNAL_API_BASE ?? 'http://localhost:3001/api';

// ─── Public chat rate limiting + cost cap ─────────────────────
// In-memory per-IP message counter, resets daily (UTC).
// Global daily cost ceiling — once exceeded, all chat requests return 429.
const RATE_PER_IP_PER_DAY = 10;
const GLOBAL_COST_CAP_USD = 0.50; // <-- public chat hard cap
const ipCounters = new Map<string, { count: number; resetAt: number }>();
let dayKey = '';
let dailyCostUsd = 0;
function rolloverIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    dailyCostUsd = 0;
    ipCounters.clear();
  }
}
function ipFromRequest(c: any): string {
  const xff = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '';
  return xff.split(',')[0].trim() || 'unknown';
}
function checkAndIncrement(ip: string): { ok: boolean; reason?: string } {
  rolloverIfNeeded();
  if (dailyCostUsd >= GLOBAL_COST_CAP_USD) {
    return { ok: false, reason: 'daily-cost-cap' };
  }
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  const cur = ipCounters.get(ip) ?? { count: 0, resetAt: tomorrow.getTime() };
  if (cur.count >= RATE_PER_IP_PER_DAY) {
    return { ok: false, reason: 'per-ip-rate' };
  }
  cur.count += 1;
  ipCounters.set(ip, cur);
  return { ok: true };
}

async function fetchInternal<T>(path: string, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${INTERNAL_BASE}${path}`, { cache: 'no-store' });
    if (!r.ok) return fallback;
    return (await r.json()) as T;
  } catch {
    return fallback;
  }
}

// ─── /harness/:slug/badge.svg ─────────────────────────────
// Shields.io-style SVG badge for embedding in READMEs.
publicPapercup.get('/harness/:slug/badge.svg', async (c) => {
  const slug = c.req.param('slug').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  if (!slug) return c.text('invalid', 400);
  const status = await fetchInternal<any>(`/harness/${slug}/status`, null);
  const counts = status?.counts ?? {};
  const passed = counts.passed ?? 0;
  const total = (counts.passed ?? 0) + (counts.failing ?? 0) + (counts.todo ?? 0)
    + (counts.in_progress ?? 0) + (counts.validating ?? 0) + (counts.blocked ?? 0);
  const failing = counts.failing ?? 0;
  const label = (slug.length > 16 ? slug.slice(0, 14) + '…' : slug);
  const value = total === 0 ? 'no features' : `${passed}/${total}`;
  const color = failing > 0 ? '#e05d44' : (passed === total && total > 0) ? '#4c1' : (passed > 0) ? '#dfb317' : '#9f9f9f';
  const labelW = label.length * 7 + 16;
  const valueW = value.length * 7 + 16;
  const totalW = labelW + valueW;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#g)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=60',
      'access-control-allow-origin': '*',
    },
  });
});

// ─── /_admin/* (strict-allowlist sanitized proxy) ──────────
// Generic mirror that proxies admin endpoints, sanitizes responses, and
// blocks all writes. Lets the public site use the EXACT admin components
// (HarnessDashboard, DepartmentHarnessDashboard) by intercepting their
// fetch() calls and rewriting `/api/harness/*` → `/api/public/papercup/_admin/harness/*`.
//
// Security envelope:
//   1. Strict path allowlist (regex per request).
//   2. GET-only — every other method returns 405 immediately.
//   3. No URL injection — query string is forwarded but path is reconstructed
//      from validated segments only.
//   4. Body scrubbed: `/home/...`, secrets, env-shaped key names dropped.
//   5. SSE proxied as empty stream that closes — admin UI handles gracefully.

const ADMIN_PROXY_ALLOWLIST = [
  // Harness endpoints (read-only)
  /^\/harness\/projects(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/status(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/health(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/agents(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/agents\/[a-z0-9-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/issues(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/issues-list(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/issues-list\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/checkpoints(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/checkpoints\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/git\/log(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/git\/diff\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/git\/show\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/git\/files\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/snapshots\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/screenshots\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/competitions\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/contract\/[a-zA-Z0-9._-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/identity\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/decisions\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/agents-summary(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/agents-by-feature(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/feature-timeline\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/feature-runs\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/threads(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/threads\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/promotion-handoff(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/recent-events(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/health-history(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/phases(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/plan-review(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/active-run(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/insights\/.+/,
  /^\/harness\/[a-z0-9-]+\/run\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/runs(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/runs\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/timeline(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/architect\/threads(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/architect\/threads\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/logs\/run(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/logs\/[a-z0-9._-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/lanes(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/proposals(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/proposals\/[a-zA-Z0-9._-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/reviews(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/features(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/features\/[a-zA-Z0-9_-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/brainstorm(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/brainstorm-canvas(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/decisions(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/identity(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/memory(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/screenshots(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/snapshots(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/hooks(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/prompts(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/prompts\/[a-z0-9-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/insights(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/triage(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/competitions(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/checkpoints(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/spec(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/contract(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/files(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/files\/.+/,
  /^\/harness\/[a-z0-9-]+\/git\/log(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/git\/status(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/tests(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/tests\/[a-z0-9-]+(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/collections(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/templates(\?|$)/,
  /^\/harness\/[a-z0-9-]+\/archives(\?|$)/,
  // SSE — proxy as a no-op stream
  /^\/harness\/[a-z0-9-]+\/stream(\?|$)/,
];

function isAllowedAdminPath(path: string): boolean {
  return ADMIN_PROXY_ALLOWLIST.some((re) => re.test(path));
}

const ADMIN_BASE_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
} as const;

function adminJsonResponse(body: any, status: number, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...ADMIN_BASE_HEADERS,
      ...(extra ?? {}),
    },
  });
}

// Rate limiter for /_admin/*: per-IP rolling window, in-memory.
// Lets the same browser hit ~60 req/min — enough for HarnessDashboard's polling
// across all panels — but blocks attempts to scrape or DoS via a single IP.
// Generous limit: HarnessDashboard polls ~8 endpoints every 4-5s plus
// initial-load burst of ~20 requests. Normal usage = ~120/min/IP. Set 600
// to leave headroom for active users with multiple tabs.
const ADMIN_RATE_LIMIT_PER_MIN = 600;
const adminBuckets = new Map<string, { count: number; resetAt: number }>();
function adminRateCheck(ip: string): { ok: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let b = adminBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + 60_000 };
    adminBuckets.set(ip, b);
  }
  b.count += 1;
  if (b.count > ADMIN_RATE_LIMIT_PER_MIN) {
    return { ok: false, remaining: 0, resetMs: b.resetAt - now };
  }
  return { ok: true, remaining: ADMIN_RATE_LIMIT_PER_MIN - b.count, resetMs: b.resetAt - now };
}

publicPapercup.all('/_admin/*', async (c) => {
  // Block writes immediately (with CORS).
  if (c.req.method !== 'GET' && c.req.method !== 'OPTIONS') {
    return adminJsonResponse({ error: 'admin mirror is read-only' }, 405);
  }
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: ADMIN_BASE_HEADERS });
  }

  // Per-IP rate limit.
  const ip = ipFromRequest(c);
  const rl = adminRateCheck(ip);
  if (!rl.ok) {
    return adminJsonResponse(
      { error: 'rate-limited', retryAfterMs: rl.resetMs },
      429,
      {
        'retry-after': String(Math.ceil(rl.resetMs / 1000)),
        'x-ratelimit-limit': String(ADMIN_RATE_LIMIT_PER_MIN),
        'x-ratelimit-remaining': '0',
      },
    );
  }

  // Strip the /_admin prefix — Hono's c.req.path includes /api/public/papercup/_admin
  const fullPath = c.req.path;
  const idx = fullPath.indexOf('/_admin/');
  if (idx === -1) return adminJsonResponse({ error: 'invalid' }, 400);
  const subPath = fullPath.slice(idx + '/_admin'.length);
  const query = new URL(c.req.url).search;
  const target = subPath + query;

  if (!isAllowedAdminPath(target)) {
    return adminJsonResponse({ error: 'path not allowed', path: subPath }, 404);
  }

  // SSE: open a long-lived stream that emits ping events every 15s.
  // The admin UI wants an active stream to render its dashboard content;
  // closing it immediately makes the component think the harness is dead.
  if (subPath.includes('/stream')) {
    return new Response(new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        // Initial connect ping
        controller.enqueue(enc.encode(`event: connected\ndata: {"ts":${Date.now()}}\n\n`));
        // Keep the stream alive with periodic pings; admin UI uses this as
        // a liveness signal even when no real events flow.
        const interval = setInterval(() => {
          try { controller.enqueue(enc.encode(`event: ping\ndata: {"ts":${Date.now()}}\n\n`)); }
          catch { clearInterval(interval); }
        }, 15_000);
        // Auto-close after 10 minutes to free resources.
        setTimeout(() => {
          try { controller.close(); } catch {}
          clearInterval(interval);
        }, 10 * 60 * 1000);
      },
    }), {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'access-control-allow-origin': '*',
      },
    });
  }

  // In-memory response cache: target → { body, status, contentType, expiresAt }.
  // 3-second TTL drops upstream load by 90%+ for the 5-second polling pattern
  // the public dashboard uses without sacrificing freshness.
  const cached = adminCache.get(target);
  const nowMs = Date.now();
  if (cached && cached.expiresAt > nowMs) {
    return new Response(cached.body, {
      status: cached.status,
      headers: {
        'content-type': cached.contentType,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-cache': 'HIT',
        'x-ratelimit-limit': String(ADMIN_RATE_LIMIT_PER_MIN),
        'x-ratelimit-remaining': String(rl.remaining),
      },
    });
  }

  // Proxy to admin internal.
  try {
    const internalUrl = INTERNAL_BASE + target;
    const r = await fetch(internalUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(60_000),
    });
    const ct = r.headers.get('content-type') ?? 'application/json';
    const text = await r.text();
    const isFreeText = /\/(logs|issues|notes|decisions|brainstorm|spec|identity|memory|prompts|charter|summaries|messages)\b/.test(subPath);
    const cleaned = isFreeText ? scrubFreeText(text) : scrub(text);
    adminCache.set(target, { body: cleaned, status: r.status, contentType: ct, expiresAt: nowMs + ADMIN_CACHE_TTL_MS });
    if (adminCache.size > 500) {
      const oldest = adminCache.keys().next().value;
      if (oldest) adminCache.delete(oldest);
    }
    return new Response(cleaned, {
      status: r.status,
      headers: {
        'content-type': ct,
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'x-cache': 'MISS',
        'x-ratelimit-limit': String(ADMIN_RATE_LIMIT_PER_MIN),
        'x-ratelimit-remaining': String(rl.remaining),
      },
    });
  } catch (e) {
    return adminJsonResponse({ error: 'upstream', message: String(e) }, 502);
  }
});

const ADMIN_CACHE_TTL_MS = 3_000;
const adminCache = new Map<string, { body: string; status: number; contentType: string; expiresAt: number }>();

// ─── /healthz ─────────────────────────────────────────────
// Lightweight liveness probe. Used for monitoring + status pages.
publicPapercup.get('/healthz', async (c) => {
  const startedMs = Date.now();
  try {
    const r = await fetch(`${INTERNAL_BASE}/harness/projects`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
    const ok = r.ok;
    return c.json({
      ok,
      version: 'g3',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      services: { internal: ok ? 'up' : 'down' },
    }, ok ? 200 : 503);
  } catch {
    return c.json({
      ok: false,
      version: 'g3',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedMs,
      services: { internal: 'down' },
    }, 503);
  }
});

// ─── /summary ─────────────────────────────────────────────
// Aggregated home-page snapshot.




// ─── /harnesses ───────────────────────────────────────────
// Now exposes BOTH department harnesses (org-*) and coding harnesses (sheets, etc.).
// `harnessKind` distinguishes them so the public UI can render appropriately.
publicPapercup.get('/harnesses', async (c) => {
  const { projects = [] } = await fetchInternal<{ projects: any[] }>('/harness/projects', { projects: [] });
  const visible = projects.filter((p: any) =>
    p.harness_kind === 'department' || (p.harness_kind === 'coding' && p.hasState),
  );
  const harnesses = await Promise.all(
    visible.map(async (p: any) => {
      const status = await fetchInternal<any>(`/harness/${p.slug}/status`, null);
      const health = await fetchInternal<any>(`/harness/${p.slug}/health`, null);
      const counts = status?.counts ?? {};
      return {
        slug: p.slug,
        harnessKind: p.harness_kind,
        director: (p.department_slug ?? p.slug).replace(/^org-/, ''),
        passed: counts.passed ?? 0,
        total: (counts.passed ?? 0) + (counts.failing ?? 0) + (counts.todo ?? 0) + (counts.in_progress ?? 0) + (counts.validating ?? 0) + (counts.blocked ?? 0),
        inProgress: counts.in_progress ?? 0,
        failing: counts.failing ?? 0,
        iteration: status?.iteration ?? 0,
        alive: health?.alive ?? status?.alive ?? false,
        lastRunMs: health?.lastRunAgeSeconds ? Date.now() - health.lastRunAgeSeconds * 1000 : null,
        costUsd: status?.missionCostUsd,
        mandate: p.harness_kind === 'coding' ? `${p.slug} — coding harness` : null,
      };
    }),
  );
  return c.json({ harnesses });
});

// ─── /harness/:slug/proposal/:id ───────────────────────────
// Read the full content of a single architect proposal (sanitized markdown).
publicPapercup.get('/harness/:slug/proposal/:id', async (c) => {
  const slug = c.req.param('slug').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80);
  if (!slug || !id || !id.endsWith('.md')) return c.json({ error: 'invalid params' }, 400);
  const r = await fetchInternal<any>(`/harness/${slug}/proposals/${id}`, null);
  if (!r || !r.content) return c.json({ error: 'not found' }, 404);
  return c.json({
    id: r.id,
    slug,
    content: capBody(r.content, 30_000),
  });
});

// ─── /harness/:slug/feature/:id ───────────────────────────
// Public per-feature detail (sanitized).
publicPapercup.get('/harness/:slug/feature/:id', async (c) => {
  const slug = c.req.param('slug').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  const id = c.req.param('id').replace(/[^A-Za-z0-9_-]/gi, '').slice(0, 80);
  if (!slug || !id) return c.json({ error: 'invalid params' }, 400);
  const status = await fetchInternal<any>(`/harness/${slug}/status`, null);
  if (!status) return c.json({ error: 'not found' }, 404);
  const feature = (status.features ?? []).find((f: any) => f.id === id);
  if (!feature) return c.json({ error: 'feature not found' }, 404);

  // Best-effort: fetch the spec excerpt + features.json body if available.
  // SPEC.md and features.json are read via /harness/:slug/feature/:id on admin (if exists),
  // but we sanitize whatever we get.
  const detail = await fetchInternal<any>(`/harness/${slug}/features/${id}`, null);
  return c.json({
    id: feature.id,
    slug,
    title: scrub(feature.title ?? ''),
    status: feature.status,
    attempts: feature.attempts ?? 0,
    claims: Array.isArray(feature.claims) ? feature.claims.slice(0, 24) : [],
    body: detail?.body ? capBody(detail.body, 8000) : null,
    spec: detail?.spec ? capBody(detail.spec, 8000) : null,
  });
});

// ─── /harness/:slug/console ───────────────────────────────
// Combined cockpit payload — the full live ops cockpit data, sanitized.
// This is the secure read-only G3 mirror of admin's HarnessDashboard data.
publicPapercup.get('/harness/:slug/console', async (c) => {
  const slug = c.req.param('slug').replace(/[^a-z0-9-]/gi, '').slice(0, 64);
  if (!slug) return c.json({ error: 'invalid slug' }, 400);

  const [status, health, agentsRes, logsRes, lanesRes, reviewsRes, proposalsRes, issuesRes] = await Promise.all([
    fetchInternal<any>(`/harness/${slug}/status`, null),
    fetchInternal<any>(`/harness/${slug}/health`, null),
    fetchInternal<any>(`/harness/${slug}/agents`, { runs: [] }),
    fetchInternal<any>(`/harness/${slug}/logs/run`, { log: '' }),
    fetchInternal<any>(`/harness/${slug}/lanes`, { lanes: [], max: 1 }),
    fetchInternal<any>(`/harness/${slug}/reviews`, { reviews: [] }),
    fetchInternal<any>(`/harness/${slug}/proposals`, { proposals: [] }),
    fetchInternal<any>(`/harness/${slug}/issues`, { issues: '' }),
  ]);

  if (!status) return c.json({ error: 'unknown harness' }, 404);

  const features = (status.features ?? []).map((f: any) => ({
    id: f.id,
    title: scrub(f.title),
    status: f.status,
    attempts: f.attempts ?? 0,
    claims: Array.isArray(f.claims) ? f.claims.slice(0, 12) : [],
  }));

  const counts = status.counts ?? {};
  const total = (counts.passed ?? 0) + (counts.failing ?? 0) + (counts.todo ?? 0)
    + (counts.in_progress ?? 0) + (counts.validating ?? 0) + (counts.blocked ?? 0);

  const agents = (agentsRes.runs ?? []).slice(0, 30).map((r: any) => ({
    runId: r.runId,
    role: r.role,
    ts: r.ts,
    sizeBytes: r.sizeBytes,
    running: !!r.running,
    lastEventTs: r.lastEventTs,
  }));

  const reviews = (reviewsRes.reviews ?? []).slice(0, 6).map((rv: any) => ({
    id: rv.id,
    kind: rv.kind,
    from: rv.from,
    to: rv.to,
    status: rv.status,
    readinessScore: rv.readinessScore,
    summary: scrub(rv.summary ?? ''),
    readinessSummary: scrub(rv.readinessSummary ?? ''),
    criteria: rv.criteria,
    question: scrub(rv.question ?? ''),
  }));

  const proposals = (proposalsRes.proposals ?? []).slice(0, 12).map((p: any) => ({
    id: p.id,
    ts: p.ts,
    sizeBytes: p.sizeBytes,
    status: p.status,
  }));

  return c.json({
    slug,
    project: { slug },
    counts: {
      passed: counts.passed ?? 0,
      failing: counts.failing ?? 0,
      todo: counts.todo ?? 0,
      in_progress: counts.in_progress ?? 0,
      validating: counts.validating ?? 0,
      blocked: counts.blocked ?? 0,
      total,
    },
    features,
    agents,
    iteration: status.iteration ?? 0,
    alive: health?.alive ?? false,
    escalated: !!status.escalated,
    pendingCheckpoints: status.pendingCheckpoints ?? 0,
    activeCompetitions: status.activeCompetitions ?? 0,
    smokeFail: !!status.smokeFail,
    missionCostUsd: status.missionCostUsd ?? 0,
    lastRunAgeSeconds: health?.lastRunAgeSeconds ?? null,
    log: capLog(logsRes.log, { maxLines: 100 }),
    lanes: (lanesRes.lanes ?? []).map((l: any) => ({
      featureId: l.featureId,
      role: l.role,
      ts: l.ts,
    })),
    laneCapacity: lanesRes.max ?? 1,
    reviews,
    proposals,
    issues: capBody(issuesRes.issues ?? '', 8000),
    healthChecks: (health?.checks ?? []).map((ck: any) => ({
      name: ck.name,
      ok: !!ck.ok,
      detail: scrub(ck.detail ?? ''),
    })),
  });
});

// ─── /harness/:slug ───────────────────────────────────────
// Per-harness drill-down: brainstorm only.
// Inbox/outbox were dropped in the org-harness migration (no /org/* anymore).
publicPapercup.get('/harness/:slug', async (c) => {
  const slug = c.req.param('slug');
  const brainstorm = await fetchInternal<{ content: string }>(`/harness/${slug}/brainstorm`, { content: '' });
  return c.json({
    slug,
    brainstorm: { content: brainstorm.content ?? '' },
  });
});


// ─── /chat ────────────────────────────────────────────────
// Public chatbot: visitor-facing AI guide for papercupai.com.
// SAFETY RAILS:
//   - Rate-limited per IP (10 messages/day)
//   - Global daily $ cap (GLOBAL_COST_CAP_USD)
//   - Forced cheap model (claude-haiku)
//   - Restricted system prompt; no access to project files (cwd = tmpdir)
//   - "promote:*" / "patch:*" / "proposal:*" action blocks stripped from output
publicPapercup.post('/chat', async (c) => {
  const ip = ipFromRequest(c);
  const gate = checkAndIncrement(ip);
  if (!gate.ok) {
    return c.json({ error: 'rate-limited', reason: gate.reason }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as
    | { history?: Array<{ role: 'user' | 'assistant'; content: string }>; message?: string; slug?: string }
    | null;
  if (!body || typeof body.message !== 'string' || body.message.length === 0) {
    return c.json({ error: 'message required' }, 400);
  }
  if (body.message.length > 2000) {
    return c.json({ error: 'message too long (2000 char max)' }, 400);
  }

  // Optional context: which harness is the visitor looking at?
  const slug = typeof body.slug === 'string' ? body.slug.replace(/[^a-z0-9-]/gi, '').slice(0, 64) : '';
  let context = '';
  if (slug) {
    try {
      const r = await fetch(`${INTERNAL_BASE}/public/papercup/harness/${slug}`, { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const brainstorm = String(j.brainstorm?.content ?? '').slice(0, 800);
        context = `\nThe visitor is looking at the ${slug} harness.\n\nBrainstorm excerpt:\n${brainstorm || '(empty)'}\n`;
      }
    } catch { /* swallow */ }
  }

  const systemPrompt = `You are the friendly public guide for papercupai.com — a live website that shows how a fully autonomous AI-driven company called Papercup operates.

Your job is to help visitors understand:
  - What Papercup is (an experimental, fully-autonomous company structure where 5 director agents run coordinated harnesses)
  - The 5 directors: Business, R&D, Technology, Management, Marketing
  - How the inbox/outbox messaging works between departments
  - What "harness", "brainstorm", "feature", "directive" mean here
  - What you see on this site is real, live, read-only data

Style:
  - Short and helpful (2–4 sentences typical, longer only if the visitor asks for depth)
  - No marketing fluff. Be direct.
  - If the visitor asks about something you don't know, say so.

Hard rules:
  - Never produce action blocks (no \`\`\`promote:, \`\`\`patch:, \`\`\`proposal:, etc.)
  - Never offer to make changes — you have no write access
  - Don't fabricate data — only describe what's plausibly visible on this site
${context}`;

  const history = (body.history ?? []).slice(-8);
  const fullPrompt = [
    ...history.map((m) => `${m.role === 'user' ? 'Visitor' : 'Guide'}: ${m.content}`),
    `Visitor: ${body.message}`,
    'Guide:',
  ].join('\n\n');

  return new Response(new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${data.replace(/\n/g, '\\n')}\n\n`));
      };

      // Buffer for filtering action blocks across deltas. The visitor
      // chatbot must never produce promote:/patch:/proposal: action
      // blocks even if the model regresses — strip them before they
      // reach the browser.
      let pendingDelta = '';
      const ACTION_RE = /```(promote|patch|proposal|note):[^\n]*\n[\s\S]*?```/g;

      const flushFilteredDelta = () => {
        const lastFenceOpen = pendingDelta.lastIndexOf('```');
        const fenceCount = (pendingDelta.match(/```/g) ?? []).length;
        if (fenceCount % 2 === 1 && lastFenceOpen !== -1) {
          const safe = pendingDelta.slice(0, lastFenceOpen);
          pendingDelta = pendingDelta.slice(lastFenceOpen);
          if (safe.length > 0) send('delta', safe.replace(ACTION_RE, ''));
          return;
        }
        const filtered = pendingDelta.replace(ACTION_RE, '');
        if (filtered.length > 0) send('delta', filtered);
        pendingDelta = '';
      };

      let doneSent = false;
      try {
        for await (const ev of runAgentChat({
          promptText: `${systemPrompt}\n\n---\n\n${fullPrompt}\n`,
          cwd: tmpdir(),
          model: 'claude-haiku-4-5',
        })) {
          if (ev.type === 'delta') {
            pendingDelta += ev.text;
            flushFilteredDelta();
          } else if (ev.type === 'result') {
            const cost = ev.costUsd;
            if (cost > 0) dailyCostUsd += cost;
            if (pendingDelta.length > 0) {
              send('delta', pendingDelta.replace(ACTION_RE, ''));
              pendingDelta = '';
            }
            if (!doneSent) { send('done', JSON.stringify({ cost })); doneSent = true; }
          } else if (ev.type === 'error') {
            send('error', `${ev.message}${ev.stderr ? `: ${ev.stderr.slice(0, 300)}` : ''}`);
          }
        }
      } catch (err) {
        send('error', `chat failed: ${(err as Error).message}`);
      }
      if (pendingDelta.length > 0) {
        send('delta', pendingDelta.replace(ACTION_RE, ''));
        pendingDelta = '';
      }
      if (!doneSent) { send('done', '{}'); doneSent = true; }
    },
  }), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
    },
  });
});

// ─── /chat-status ─────────────────────────────────────────
// Lightweight status — used by the public client to render rate-limit feedback.
publicPapercup.get('/chat-status', (c) => {
  rolloverIfNeeded();
  const ip = ipFromRequest(c);
  const cur = ipCounters.get(ip);
  const remaining = Math.max(0, RATE_PER_IP_PER_DAY - (cur?.count ?? 0));
  return c.json({
    remaining,
    limitPerDay: RATE_PER_IP_PER_DAY,
    globalCostExhausted: dailyCostUsd >= GLOBAL_COST_CAP_USD,
    dayKey,
  });
});

// ─── 405 / 404 handler ────────────────────────────────────
publicPapercup.all('*', (c) => {
  if (c.req.method === 'GET') return c.notFound();
  return c.json({ error: 'public papercup is read-only' }, 405);
});
