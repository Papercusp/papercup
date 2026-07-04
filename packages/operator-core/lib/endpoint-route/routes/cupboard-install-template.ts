/**
 * POST /api/cupboard/install-template — install a template from the Cupboard
 * (app-templates-2026-07-04 P-010).
 *
 * A `kind=template` listing is GitHub-repo-backed like a blueprint; installing
 * it = git-clone the repo, locate `templates/<listing_ref>/template.yaml`
 * (or `<listing_ref>/`, or the root), validate it (kit schema +
 * component-catalog cross-validation — a stale pin fails loudly), and place
 * the whole dir under `~/.papercusp/templates/<id>/`, where the P-011 thin
 * materializer reads it.
 *
 * Body: { listingId?, githubUrl?, listingRef? }
 *   - listingId  resolve the repo URL + listing_ref from the Cupboard listing
 *   - githubUrl  OR install a repo directly (listingRef = template subdir/id)
 *
 * `auth: 'loopback'` — loopback-only via the operator's Host-header gate, like
 * the sibling cupboard routes.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveCupboardBaseUrl } from '../../cupboard/base-url';
import { INSTALLED_TEMPLATES_DIR } from '../../cupboard/installed-templates';
import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
} from '../../cupboard/install-template-core';

function gitCloneShallow(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`git clone failed (exit ${code}): ${err.slice(0, 300)}`)),
    );
  });
}

/** Resolve a Cupboard listing id → { githubUrl, listingRef }, kind-checked. */
async function resolveTemplateListing(
  id: string,
): Promise<{ githubUrl: string; listingRef?: string } | { error: string; status: number }> {
  const base = resolveCupboardBaseUrl();
  let row: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: 'listing_not_found_or_unreachable', status: 404 };
    const data = (await res.json()) as Record<string, unknown> | null;
    row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
  } catch {
    return { error: 'listing_not_found_or_unreachable', status: 404 };
  }
  if (row?.listing_kind !== 'template') {
    return { error: `listing is kind=${String(row?.listing_kind ?? 'unknown')}, not a template`, status: 422 };
  }
  const githubUrl = typeof row.github_url === 'string' ? row.github_url : '';
  if (!githubUrl) return { error: 'listing has no github_url', status: 422 };
  const listingRef = typeof row.listing_ref === 'string' ? row.listing_ref : undefined;
  return { githubUrl, listingRef };
}

export default defineTool({
  method: 'POST',
  path: '/cupboard/install-template',
  auth: 'loopback',
  timeoutSec: 120,
  async handler(req) {
    let body: { listingId?: string; githubUrl?: string; listingRef?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
    }

    let githubUrl = typeof body.githubUrl === 'string' ? body.githubUrl.trim() : '';
    let listingRef = typeof body.listingRef === 'string' ? body.listingRef.trim() : undefined;

    if (!githubUrl && body.listingId) {
      const resolved = await resolveTemplateListing(String(body.listingId));
      if ('error' in resolved) {
        return Response.json({ ok: false, error: resolved.error }, { status: resolved.status });
      }
      githubUrl = resolved.githubUrl;
      listingRef = listingRef ?? resolved.listingRef;
    }
    if (!githubUrl) {
      return Response.json({ ok: false, error: 'githubUrl or listingId required' }, { status: 400 });
    }

    try {
      const result = await installTemplateFromCupboardCore(
        { githubUrl, listingRef },
        { cloneRepo: gitCloneShallow, installedTemplatesDir: INSTALLED_TEMPLATES_DIR, tmpDir: tmpdir },
      );
      return Response.json(result);
    } catch (e) {
      if (e instanceof InstallTemplateError) {
        return Response.json({ ok: false, error: e.message }, { status: e.status });
      }
      return Response.json(
        { ok: false, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) },
        { status: 500 },
      );
    }
  },
});
