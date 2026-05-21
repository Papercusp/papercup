/**
 * POST /api/marketplace/uninstall
 *
 * Uninstalls a marketplace plugin via the CLI (`papercusp uninstall`).
 *
 * Ported from app/api/marketplace/uninstall/route.ts. `auth: 'public'`.
 */
import { spawn } from 'node:child_process';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineTool } from '@papercusp/agent-mcp';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

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

export default defineTool({
  method: 'POST',
  path: '/marketplace/uninstall',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
    if (blocked) return blocked;
    let body: { slug?: string };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
    const slug = String(body.slug ?? '').trim();
    if (!SLUG_RE.test(slug)) return Response.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });

    const r = await run(PAPERCUSP_BIN, ['uninstall', slug]);
    if (r.code !== 0) {
      return Response.json({
        ok: false,
        error: 'papercusp uninstall failed',
        log: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      }, { status: 500 });
    }
    return Response.json({ ok: true, slug, log: r.stdout });
  },
});
