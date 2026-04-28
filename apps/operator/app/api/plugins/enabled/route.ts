import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAPERCUSP_ROOT = join(homedir(), '.papercusp');
const HARNESSES_DIR = join(PAPERCUSP_ROOT, 'harnesses');

interface EnabledFile {
  enabled: Record<string, { version: string; enabledAt: string; configHash: string }>;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filterPlugin = url.searchParams.get('plugin');
  const out: Record<string, string[]> = {}; // harness → enabled plugin slugs
  if (!existsSync(HARNESSES_DIR)) return NextResponse.json({ enabled: out });
  const dirs = await fs.readdir(HARNESSES_DIR, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = await readJson<EnabledFile>(join(HARNESSES_DIR, d.name, 'enabled-plugins.json'));
    const slugs = file ? Object.keys(file.enabled) : [];
    out[d.name] = slugs;
  }
  if (filterPlugin) {
    const result: Record<string, boolean> = {};
    for (const [h, slugs] of Object.entries(out)) result[h] = slugs.includes(filterPlugin);
    return NextResponse.json({ plugin: filterPlugin, byHarness: result });
  }
  return NextResponse.json({ enabled: out });
}
