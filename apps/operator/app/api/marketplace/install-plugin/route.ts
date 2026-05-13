import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { spawn } from 'node:child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function isValidSlug(s: string): boolean {
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

export async function POST(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
  if (blocked) return blocked;
  let body: { slug?: string; version?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const slug = String(body.slug ?? '').trim();
  if (!isValidSlug(slug)) return NextResponse.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });
  const version = body.version ? String(body.version).trim() : undefined;
  if (version && !/^[a-z0-9.+\-]+$/i.test(version)) {
    return NextResponse.json({ ok: false, error: `invalid version "${version}"` }, { status: 400 });
  }

  const env = {
    ...process.env,
    PAPERCUSP_MARKETPLACE_URL: process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057',
    // Auto-accept first-grant capability prompt on UI install — operator
    // explicitly clicked Install in our UI, which is the consent gesture.
    PAPERCUSP_ACCEPT_CAPABILITIES: '1',
  };

  const target = version ? `${slug}@${version}` : slug;
  const r = await run(PAPERCUSP_BIN, ['install', target, '--accept-capabilities'], env);
  if (r.code !== 0) {
    return NextResponse.json({
      ok: false,
      error: 'papercusp install failed',
      log: [r.stdout, r.stderr].filter(Boolean).join('\n'),
    }, { status: 500 });
  }

  // Invalidate the in-process plugin host cache so the just-installed plugin
  // is discovered on the next request. Also kicks the apiRoutes mounter cache
  // so any apiRoutes the new plugin ships go live without a server restart.
  // Best-effort — these caches are operator-side conveniences, never required
  // for the install itself to be considered successful.
  try {
    const { _resetPluginHostForTests } = await import('../../../../lib/plugin-host-runtime');
    _resetPluginHostForTests();
  } catch { /* host runtime not initialized yet — fine */ }
  try {
    const { _resetPluginApiRoutesForTests } = await import('../../../../lib/plugin-api-mount');
    _resetPluginApiRoutesForTests();
  } catch { /* mount cache not initialized yet — fine */ }

  return NextResponse.json({ ok: true, slug, log: r.stdout });
}
