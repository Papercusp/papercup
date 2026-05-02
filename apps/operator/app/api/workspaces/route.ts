/**
 * GET /api/workspaces — list workspaces + the current one.
 * POST /api/workspaces — create a new workspace.
 *
 * In desktop mode, the Tauri shell exposes these as direct commands
 * (workspaces_list, workspaces_create) and the WorkspaceSwitcher prefers
 * those. In webapp mode there is no Tauri shell, so the wrapper falls
 * back to these HTTP endpoints; both write the same registry.json file.
 */

import { NextResponse } from 'next/server';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const REGISTRY_PATH = join(homedir(), '.papercusp-workspaces', 'registry.json');

interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

interface Registry {
  current: string;
  workspaces: Workspace[];
}

async function readRegistry(): Promise<Registry> {
  if (!existsSync(REGISTRY_PATH)) return { current: '', workspaces: [] };
  try {
    return JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8')) as Registry;
  } catch {
    return { current: '', workspaces: [] };
  }
}

async function writeRegistry(reg: Registry): Promise<void> {
  await fs.mkdir(join(homedir(), '.papercusp-workspaces'), { recursive: true });
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) throw new Error('name resolves to empty slug');
  return base;
}

export async function GET() {
  return NextResponse.json(await readRegistry());
}

export async function POST(req: Request) {
  let body: { name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 }); }
  const name = String(body.name ?? '').trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name required' }, { status: 400 });

  const reg = await readRegistry();
  let id: string;
  try {
    id = slugify(name);
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
  // Disambiguate against existing slugs by appending a numeric suffix.
  let candidate = id;
  let n = 2;
  while (reg.workspaces.some((w) => w.id === candidate)) {
    candidate = `${id}-${n++}`;
  }
  id = candidate;

  const dir = join(homedir(), '.papercusp-workspaces', id);
  await fs.mkdir(join(dir, '.papercusp'), { recursive: true });

  const ws: Workspace = { id, name, createdAt: Date.now() };
  reg.workspaces.push(ws);
  if (!reg.current) reg.current = id;
  await writeRegistry(reg);

  return NextResponse.json(ws);
}
