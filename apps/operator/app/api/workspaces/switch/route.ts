/**
 * POST /api/workspaces/switch — change the active workspace.
 *
 * Updates registry.json's `current` field. The operator's papercuspRoot()
 * resolver invalidates its cache on registry mtime change, so subsequent
 * requests transparently read from the new workspace's filesystem state.
 *
 * Note for the desktop shell: this endpoint is webapp-only. The desktop
 * uses the workspaces_switch Tauri command instead, which additionally
 * kills the sidecar + pglite-server before flipping `current`. In webapp
 * mode there's no sidecar to kill — the dev operator just picks up the
 * new path on the next call.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REGISTRY_PATH = join(homedir(), '.papercusp-workspaces', 'registry.json');

interface Registry {
  current: string;
  workspaces: { id: string; name: string; createdAt: number }[];
}

export async function POST(req: Request) {
  let body: { id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const id = String(body.id ?? '').trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: `invalid workspace id "${id}"` }, { status: 400 });
  }
  if (!existsSync(REGISTRY_PATH)) {
    return NextResponse.json({ ok: false, error: 'no workspace registry on disk' }, { status: 404 });
  }
  const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8')) as Registry;
  if (!reg.workspaces.some((w) => w.id === id)) {
    return NextResponse.json({ ok: false, error: `unknown workspace "${id}"` }, { status: 404 });
  }
  if (reg.current === id) {
    return NextResponse.json({ ok: true, id, alreadyCurrent: true });
  }
  reg.current = id;
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  return NextResponse.json({ ok: true, id });
}
