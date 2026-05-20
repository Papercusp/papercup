/**
 * POST /api/marketplace/install-plugin
 *
 * Installs a marketplace plugin via the CLI (`papercusp install`). Auto-
 * accepts capabilities (the user explicitly clicked Install in our UI).
 * Invalidates plugin-host + apiRoutes caches so the new plugin's tools
 * and routes go live without a server restart.
 *
 * Ported from app/api/marketplace/install-plugin/route.ts. `auth: 'public'`.
 */
import { spawn } from 'node:child_process';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineRoute } from '../../define-route';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';
const SLUG_RE = /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i;
const VERSION_RE = /^[a-z0-9.+\-]+$/i;

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

export default defineRoute({
  method: 'POST',
  path: '/marketplace/install-plugin',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
    if (blocked) return blocked;
    let body: { slug?: string; version?: string };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
    const slug = String(body.slug ?? '').trim();
    if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });
    const version = body.version ? String(body.version).trim() : undefined;
    if (version && !VERSION_RE.test(version)) {
      return Response.json({ ok: false, error: `invalid version "${version}"` }, { status: 400 });
    }

    const env = {
      ...process.env,
      PAPERCUSP_MARKETPLACE_URL: process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057',
      PAPERCUSP_ACCEPT_CAPABILITIES: '1',
    };

    const target = version ? `${slug}@${version}` : slug;
    const r = await run(PAPERCUSP_BIN, ['install', target, '--accept-capabilities'], env);
    if (r.code !== 0) {
      return Response.json({
        ok: false,
        error: 'papercusp install failed',
        log: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      }, { status: 500 });
    }

    try {
      const { _resetPluginHostForTests } = await import('@/lib/plugin-host-runtime');
      _resetPluginHostForTests();
    } catch { /* host runtime not initialized yet */ }
    try {
      const { _resetPluginApiRoutesForTests } = await import('@/lib/plugin-api-mount');
      _resetPluginApiRoutesForTests();
    } catch { /* mount cache not initialized yet */ }

    return Response.json({ ok: true, slug, log: r.stdout });
  },
});
