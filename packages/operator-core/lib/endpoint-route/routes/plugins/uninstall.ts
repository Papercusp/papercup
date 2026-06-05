/**
 * POST /api/plugins/uninstall — papercusp plugin uninstall + runtime reset.
 * Ported from app/api/plugins/uninstall/route.ts. `auth: 'public'`.
 */
import { spawn } from 'node:child_process';
import { triggerSnapshotEvent } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { resolvePapercuspCli } from '../../../papercusp-cli';
import { defineTool } from '@papercusp/agent-mcp';

const PAPERCUSP_BIN = resolvePapercuspCli();

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
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

export default defineTool({
  method: 'POST',
  path: '/plugins/uninstall',
  auth: 'public',
  async handler(req) {
    let body: { slug?: string; purgeGrants?: boolean };
    try { body = await req.json(); } catch { return Response.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
    const slug = String(body.slug ?? '').trim();
    if (!isValidSlug(slug)) return Response.json({ ok: false, error: `invalid slug "${slug}"` }, { status: 400 });

    await triggerSnapshotEvent(activeWorkspaceId(), 'pre_destructive', { op: 'plugin_uninstall', slug, purgeGrants: !!body.purgeGrants })
      .catch(() => { /* ignore */ });

    const args = ['plugin', 'uninstall', slug];
    if (body.purgeGrants) args.push('--purge-grants');
    const r = await run(PAPERCUSP_BIN, args);
    if (r.code !== 0) {
      return Response.json({
        ok: false,
        error: 'papercusp plugin uninstall failed',
        log: [r.stdout, r.stderr].filter(Boolean).join('\n'),
      }, { status: 500 });
    }

    try {
      const { _resetPluginHostForTests } = await import('../../../plugin-host-runtime');
      _resetPluginHostForTests();
    } catch { /* not initialized */ }
    try {
      const { _resetPluginApiRoutesForTests } = await import('../../../plugin-api-mount');
      _resetPluginApiRoutesForTests();
    } catch { /* not initialized */ }

    return Response.json({ ok: true, slug, log: r.stdout });
  },
});
