/**
 * POST /api/desktop/workspace-validate
 *   body: { path: string }
 *   200 { ok: true, normalized: string, exists: boolean, writable: boolean }
 *   200 { ok: false, reason: string }
 *
 * Pre-flight check for the Setup Wizard's "Default project directory"
 * field. We catch bad paths here so the user gets feedback when they
 * type, not later when the first project scaffold fails.
 *
 * Checks:
 *   - Absolute path, or starts with `~/` (expanded server-side).
 *   - Not inside `~/.papercusp-workspaces/` (the per-workspace state
 *     dir is managed by the Tauri shell; user-pickable project dirs
 *     must stay outside it to avoid confusion + double-recursion).
 *   - If the path exists, must be a writable directory.
 *   - If it doesn't exist, the parent must be a writable directory
 *     (we'd create it on first project).
 */
import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function isLoopback(req: NextRequest): boolean {
  const host = req.headers.get('host') ?? '';
  return (
    host.startsWith('127.0.0.1:') ||
    host.startsWith('localhost:') ||
    host === '127.0.0.1' ||
    host === 'localhost'
  );
}

function expand(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  if (trimmed === '~') return homedir();
  return resolve(trimmed);
}

async function isWritableDir(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isDirectory()) return false;
    await fs.access(path, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!isLoopback(req)) return NextResponse.json({ error: 'loopback only' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { path?: string } | null;
  if (!body || typeof body.path !== 'string') {
    return NextResponse.json({ ok: false, reason: 'invalid body' }, { status: 400 });
  }
  if (body.path.trim().length === 0) {
    return NextResponse.json({ ok: true, normalized: '', exists: false, writable: true });
  }

  const normalized = expand(body.path);

  if (!normalized.startsWith('/')) {
    return NextResponse.json({
      ok: false,
      reason: 'Path must be absolute (start with `/` or `~/`).',
    });
  }

  const reserved = join(homedir(), '.papercusp-workspaces');
  if (normalized === reserved || normalized.startsWith(reserved + '/')) {
    return NextResponse.json({
      ok: false,
      reason: `Pick a path outside ${reserved}. That directory is managed by Papercusp.`,
    });
  }

  const exists = existsSync(normalized);
  if (exists) {
    const writable = await isWritableDir(normalized);
    if (!writable) {
      return NextResponse.json({
        ok: false,
        reason: 'That path exists but isn\'t a writable directory.',
      });
    }
    return NextResponse.json({ ok: true, normalized, exists: true, writable: true });
  }
  // Doesn't exist — check parent is writable so we can mkdir later.
  const parentWritable = await isWritableDir(dirname(normalized));
  if (!parentWritable) {
    return NextResponse.json({
      ok: false,
      reason: `Parent directory ${dirname(normalized)} doesn't exist or isn't writable.`,
    });
  }
  return NextResponse.json({ ok: true, normalized, exists: false, writable: true });
}
