import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mirrorHarness } from '../../../../lib/plugin-enables-pg';

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

function isValidPluginSlug(s: string): boolean {
  return /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i.test(s);
}

const GLOBAL_PLUGINS_DIR = join(homedir(), '.papercusp', 'global-plugins');

/**
 * The CLI keys enable/disable by on-disk dir name. Manifest `name` may be a
 * scoped form like `@papercupai/jira-sync` while the dir is `jira-sync` —
 * translate so the UI can pass either and we always do the right thing.
 */
async function resolveDirSlug(input: string): Promise<string> {
  // Already a valid dir name — common case.
  if (existsSync(join(GLOBAL_PLUGINS_DIR, input))) return input;
  // Otherwise scan all dirs and look for a manifest whose `name` matches.
  if (!existsSync(GLOBAL_PLUGINS_DIR)) return input;
  const entries = await fs.readdir(GLOBAL_PLUGINS_DIR, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      const m = JSON.parse(await fs.readFile(join(GLOBAL_PLUGINS_DIR, e.name, 'papercusp.json'), 'utf8'));
      if (m?.name === input) return e.name;
    } catch { /* skip */ }
  }
  return input;
}
function isValidHarnessSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(s);
}

export async function POST(req: Request) {
  let body: { slug?: string; harnesses?: string[]; disable?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const slug = String(body.slug ?? '').trim();
  if (!isValidPluginSlug(slug)) return NextResponse.json({ ok: false, error: `invalid plugin slug "${slug}"` }, { status: 400 });

  const harnesses = Array.isArray(body.harnesses) ? body.harnesses.map((s) => String(s).trim()).filter(Boolean) : [];
  if (harnesses.length === 0) return NextResponse.json({ ok: false, error: 'harnesses[] required' }, { status: 400 });
  for (const h of harnesses) {
    if (!isValidHarnessSlug(h)) {
      return NextResponse.json({ ok: false, error: `invalid harness slug "${h}"` }, { status: 400 });
    }
  }

  // Translate manifest name → dir basename if needed (e.g. @papercupai/jira-sync → jira-sync).
  const cliSlug = await resolveDirSlug(slug);

  const verb = body.disable ? 'disable' : 'enable';
  const results: Array<{ harness: string; ok: boolean; log: string }> = [];
  let firstFailure: { harness: string; log: string } | null = null;
  for (const h of harnesses) {
    const args = ['plugin', verb, cliSlug, '--harness', h];
    if (verb === 'enable') args.push('--accept-defaults');
    const r = await run(PAPERCUSP_BIN, args);
    const log = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const ok = r.code === 0;
    results.push({ harness: h, ok, log });
    if (!ok && !firstFailure) firstFailure = { harness: h, log };
    // Mirror the on-disk JSON into PG so cross-harness reads stay current.
    // Best-effort: a failed mirror should not turn a successful CLI run into
    // a 500. The next write or the backfill script will reconcile.
    try { await mirrorHarness(h); } catch (e) {
      console.warn('[plugins/enable] PG mirror failed for', h, e);
    }
  }
  const allOk = results.every((r) => r.ok);
  return NextResponse.json({
    ok: allOk,
    slug,
    verb,
    results,
    ...(firstFailure ? { error: `${verb} failed for ${firstFailure.harness}` } : {}),
  }, { status: allOk ? 200 : 500 });
}
