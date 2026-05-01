/**
 * POST /api/admin/rotate-token
 *
 * Generates a fresh harness_token for the calling harness, mirrors it to
 * harness_<slug>.config_token + harness_shared.token_index, and writes
 * it back to <harnessDir>/.harness/config.json (mode 0600). The OLD
 * token is invalidated immediately (deleted from token_index).
 *
 * Auth: caller must present their CURRENT bearer token. Successful
 * rotation invalidates that bearer; the response carries the new token
 * in the JSON body so the caller can update its config.json.
 *
 * Documented as v2 in docs/spec/auth-and-identity.mdx.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deriveCallerFromBearer } from '@/lib/execute-action';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function slugToSchema(slug: string): string {
  return 'harness_' + slug.replace(/-/g, '_').toLowerCase();
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function POST(req: Request) {
  const auth = await deriveCallerFromBearer(req.headers.get('authorization'));
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error, detail: auth.detail }, { status: auth.status });
  }
  const slug = auth.slug;

  // Find the harness's path in the registry so we can write the new token.
  let harnessPath: string | null = null;
  try {
    const r = await fetch(`${process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055'}/api/harness/projects`);
    if (r.ok) {
      const d: any = await r.json();
      const row = (d?.projects ?? []).find((p: any) => p.slug === slug);
      if (row) harnessPath = row.path;
    }
  } catch { /* fall through */ }

  if (!harnessPath || !existsSync(harnessPath)) {
    return NextResponse.json(
      { ok: false, error: 'not_found', detail: `harness ${slug} path not found in registry` },
      { status: 404 },
    );
  }

  const newToken = base64url(randomBytes(32));
  const oldToken = req.headers.get('authorization')!.slice(7).trim();
  const schema = slugToSchema(slug);
  const { sql } = getOrgPg();

  // Atomic-ish: insert new token, update token_index, then write to disk,
  // then drop the old token. Order matters: if disk write fails we don't
  // want to have already lost the old token.
  try {
    await sql.unsafe(`INSERT INTO ${schema}.config_token (token) VALUES ($1) ON CONFLICT (token) DO NOTHING`, [newToken]);
    // token_index has UNIQUE on harness_slug — UPDATE in place rather than INSERT.
    // Keep the row's PK on `token` updated atomically.
    await sql`
      INSERT INTO harness_shared.token_index (token, harness_slug)
      VALUES (${newToken}, ${slug})
      ON CONFLICT (harness_slug) DO UPDATE SET token = EXCLUDED.token, created_at = now()
    `;
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'internal', detail: `failed to insert new token: ${e?.message}` },
      { status: 500 },
    );
  }

  // Write to disk before invalidating old token, so a crash here leaves
  // both tokens valid (caller can retry; idempotent).
  const cfgPath = join(harnessPath, '.harness', 'config.json');
  try {
    let cfg: any = {};
    if (existsSync(cfgPath)) {
      cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    } else {
      await fs.mkdir(join(harnessPath, '.harness'), { recursive: true });
    }
    cfg.harness_token = newToken;
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    await fs.chmod(cfgPath, 0o600);
  } catch (e: any) {
    // Roll back the new-token insert
    try {
      await sql`DELETE FROM harness_shared.token_index WHERE token = ${newToken}`;
      await sql.unsafe(`DELETE FROM ${schema}.config_token WHERE token = $1`, [newToken]);
    } catch { /* ignore */ }
    return NextResponse.json(
      { ok: false, error: 'internal', detail: `failed to write config.json: ${e?.message}` },
      { status: 500 },
    );
  }

  // Drop the old token. Future requests with it return 401.
  try {
    await sql`DELETE FROM harness_shared.token_index WHERE token = ${oldToken}`;
    await sql.unsafe(`DELETE FROM ${schema}.config_token WHERE token = $1`, [oldToken]);
  } catch (e: any) {
    // Old token still works — not great, but the new one is also active.
    // Return success but flag the partial state.
    return NextResponse.json({
      ok: true,
      slug,
      newToken,
      warning: `old token cleanup failed: ${e?.message}`,
    });
  }

  return NextResponse.json({
    ok: true,
    slug,
    newToken,
  });
}
