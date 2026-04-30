import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function isValidSlug(s: string): boolean {
  // Plugin slugs may include `@scope/name` form.
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

export async function POST(req: Request) {
  let body: { slug?: string; purgeGrants?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const slug = String(body.slug ?? '').trim();
  if (!isValidSlug(slug)) return NextResponse.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });

  const args = ['plugin', 'uninstall', slug];
  if (body.purgeGrants) args.push('--purge-grants');
  const r = await run(PAPERCUSP_BIN, args);
  if (r.code !== 0) {
    return NextResponse.json({
      ok: false,
      error: 'papercusp plugin uninstall failed',
      log: [r.stdout, r.stderr].filter(Boolean).join('\n'),
    }, { status: 500 });
  }

  // Drop the just-removed plugin from the in-process runtime caches so the
  // next request stops serving stale state.
  try {
    const { _resetPluginHostForTests } = await import('../../../../lib/plugin-host-runtime');
    _resetPluginHostForTests();
  } catch { /* not initialized — fine */ }
  try {
    const { _resetPluginApiRoutesForTests } = await import('../../../../lib/plugin-api-mount');
    _resetPluginApiRoutesForTests();
  } catch { /* not initialized — fine */ }

  return NextResponse.json({ ok: true, slug, log: r.stdout });
}
