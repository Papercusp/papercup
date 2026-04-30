/**
 * POST /api/snapshots/<id>/retract
 *
 * Proxies a retract request to the marketplace API at :3057. Maps to the
 * marketplace's M6 retraction surface:
 *
 *   action='deprecate'   → POST /v1/packages/:slug/deprecate
 *   action='withdraw'    → POST /v1/packages/:slug/withdraw
 *   action='yank'        → POST /v1/packages/:slug/versions/:version/yank
 *
 * The operator-side endpoint exists because the snapshot E2E test (2026-04-30)
 * surfaced that there was no path to retract a published snapshot from the
 * operator UI — operators had to know the marketplace URL + endpoint shape.
 *
 * Body:
 *   - `marketplaceSlug` (required) — the slug the snapshot was published as
 *     (returned by `/publish` as `slug`).
 *   - `version` (required for yank) — version string.
 *   - `action` ('deprecate' | 'withdraw' | 'yank'; default 'deprecate').
 *   - `reason` (optional) — human-readable reason, ≤1000 chars.
 *
 * Auth: same service token the publish endpoint reads from
 * `~/.papercusp/marketplace-secrets.env`. Local-dev marketplaces with no
 * auth still work because the marketplace's deprecate/withdraw/yank routes
 * accept `requiresOperator: false`.
 */
import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findSnapshot } from '@/lib/snapshot-discovery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
const SECRETS_PATH = join(homedir(), '.papercusp', 'marketplace-secrets.env');

const VALID_ACTIONS = ['deprecate', 'undeprecate', 'withdraw', 'unwithdraw', 'yank'] as const;
type RetractAction = (typeof VALID_ACTIONS)[number];

const SLUG_RE = /^[A-Za-z0-9._@/-]{1,256}$/;

interface Body {
  marketplaceSlug?: string;
  version?: string;
  action?: RetractAction;
  reason?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Sanity-check the snapshot exists locally — protects operators from
  // typo'ing a snapshot id and accidentally retracting an unrelated package.
  const snap = await findSnapshot(id);
  if (!snap) {
    return NextResponse.json({ ok: false, error: 'snapshot not found locally' }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Body;
  const action: RetractAction = (body.action as RetractAction) ?? 'deprecate';
  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { ok: false, error: `invalid action "${body.action}"; expected one of ${VALID_ACTIONS.join('|')}` },
      { status: 400 },
    );
  }

  const slug = (body.marketplaceSlug ?? '').trim();
  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json(
      { ok: false, error: 'marketplaceSlug required (the slug returned by /publish)' },
      { status: 400 },
    );
  }
  if (action === 'yank') {
    if (!body.version || !SLUG_RE.test(body.version)) {
      return NextResponse.json(
        { ok: false, error: 'version required for action="yank"' },
        { status: 400 },
      );
    }
  }

  const token = await readServiceToken();
  // Token is allowed to be missing for actions that don't require operator
  // auth (deprecate / withdraw / yank). The marketplace decides; we just pass
  // whatever we have.

  const url =
    action === 'yank'
      ? `${MARKETPLACE_URL}/v1/packages/${encodeURIComponent(slug)}/versions/${encodeURIComponent(body.version!)}/yank`
      : `${MARKETPLACE_URL}/v1/packages/${encodeURIComponent(slug)}/${action}`;

  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reason, actor: 'operator-ui' }),
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: `marketplace unreachable at ${MARKETPLACE_URL}: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  const respBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, status: res.status, error: 'marketplace rejected', detail: respBody },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    slug,
    version: body.version,
    action,
    reason,
    response: respBody,
  });
}

async function readServiceToken(): Promise<string | null> {
  try {
    const raw = await fs.readFile(SECRETS_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^PAPERCUSP_MARKETPLACE_SERVICE_TOKENS\s*=\s*'(.+?)'\s*$/.exec(line.trim());
      if (m) {
        const arr = JSON.parse(m[1]!) as { token: string }[];
        return arr[0]?.token ?? null;
      }
    }
  } catch { /* file missing */ }
  return null;
}
