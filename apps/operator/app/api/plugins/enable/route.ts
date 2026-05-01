import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mirrorHarness } from '../../../../lib/plugin-enables-pg';
import { resolvePluginCliSlug } from '../../../../lib/plugin-slug';
import {
  pluginAllowsKind,
  readPluginRequiresTemplateKinds,
  resolveTemplateKind,
} from '../../../../lib/template-kind';

import { papercuspPath } from '@/lib/papercusp-root';
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

const GLOBAL_PLUGINS_DIR = papercuspPath('global-plugins');

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
  const cliSlug = await resolvePluginCliSlug(slug);

  const verb = body.disable ? 'disable' : 'enable';

  // Template-kind gate (§16): refuse `enable` if the plugin's
  // `requiresTemplateKinds[]` excludes any of the target harnesses' kinds.
  // Disabling is always allowed regardless of kind.
  if (verb === 'enable') {
    const required = await readPluginRequiresTemplateKinds(join(GLOBAL_PLUGINS_DIR, cliSlug));
    if (required && required.length > 0) {
      const incompatible: { harness: string; kind: string }[] = [];
      for (const h of harnesses) {
        const kind = await resolveTemplateKind(h);
        if (!pluginAllowsKind(required, kind)) incompatible.push({ harness: h, kind });
      }
      if (incompatible.length > 0) {
        const list = incompatible.map((i) => `${i.harness} (kind=${i.kind})`).join(', ');
        return NextResponse.json(
          {
            ok: false,
            error: `plugin "${slug}" requires templateKinds=[${required.join(', ')}]; incompatible with ${list}`,
            requiresTemplateKinds: required,
            incompatible,
          },
          { status: 422 },
        );
      }
    }
  }
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
