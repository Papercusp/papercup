import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_BIN = process.env.PAPERCUSP_CLI ?? 'papercusp';
const GLOBAL_PLUGINS_DIR = join(homedir(), '.papercusp', 'global-plugins');

async function resolveDirSlug(input: string): Promise<string> {
  if (existsSync(join(GLOBAL_PLUGINS_DIR, input))) return input;
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

const PLUGIN_SLUG = /^@?[a-z0-9][a-z0-9._/-]{0,127}$/i;
const HARNESS_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ACTION_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export async function POST(req: Request) {
  let body: { slug?: string; action?: string; harness?: string; params?: Record<string, unknown> };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }

  const slug = String(body.slug ?? '').trim();
  const action = String(body.action ?? '').trim();
  const harness = String(body.harness ?? '').trim();

  if (!PLUGIN_SLUG.test(slug)) return NextResponse.json({ ok: false, error: `invalid plugin slug` }, { status: 400 });
  if (!ACTION_ID.test(action)) return NextResponse.json({ ok: false, error: `invalid action id` }, { status: 400 });
  if (!HARNESS_SLUG.test(harness)) return NextResponse.json({ ok: false, error: `invalid harness slug` }, { status: 400 });

  const cliSlug = await resolveDirSlug(slug);
  const args = ['plugin', 'invoke', cliSlug, action, '--harness', harness];
  if (body.params && typeof body.params === 'object') {
    args.push('--params', JSON.stringify(body.params));
  }

  const r = await run(PAPERCUSP_BIN, args);
  const log = [r.stdout, r.stderr].filter(Boolean).join('\n');
  if (r.code !== 0) {
    return NextResponse.json({
      ok: false,
      slug, action, harness,
      error: `invoke exited ${r.code}`,
      log,
    }, { status: 500 });
  }
  return NextResponse.json({
    ok: true, slug, action, harness,
    result: r.stdout.trim(),
    log,
  });
}
