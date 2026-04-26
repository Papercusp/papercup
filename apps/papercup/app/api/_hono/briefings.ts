/**
 * Papercup briefings API. Tracks AI-generated shareholder-meeting videos.
 *
 * Storage:
 *   ~/.restart-org/briefings.json — list of {id, status, youtube_url, ...}
 *
 * Lifecycle states (in order):
 *   draft → rendering → rendered → uploading → uploaded
 *   any stage may transition to: failed
 */
import { Hono } from 'hono';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const ORG_ROOT = join(homedir(), '.restart-org');
const BRIEFINGS_PATH = join(ORG_ROOT, 'briefings.json');

type BriefingStatus =
  | 'draft' | 'rendering' | 'rendered' | 'uploading' | 'uploaded' | 'failed';

interface Briefing {
  id: string;
  title: string;
  quarter: string;
  status: BriefingStatus;
  created_at: string;
  script_path: string | null;
  duration_seconds: number | null;
  youtube_url: string | null;
  youtube_video_id: string | null;
  thumbnail_url: string | null;
  render_log: string | null;
  error: string | null;
  summary: string | null;
}

async function readBriefings(): Promise<Briefing[]> {
  if (!existsSync(BRIEFINGS_PATH)) return [];
  try {
    const raw = await readFile(BRIEFINGS_PATH, 'utf8');
    return (JSON.parse(raw)?.briefings ?? []) as Briefing[];
  } catch {
    return [];
  }
}

async function writeBriefings(list: Briefing[]): Promise<void> {
  await mkdir(dirname(BRIEFINGS_PATH), { recursive: true });
  await writeFile(BRIEFINGS_PATH, JSON.stringify({ briefings: list }, null, 2), 'utf8');
}

function nextId(list: Briefing[]): string {
  let max = 0;
  for (const b of list) {
    const m = /^BRF-(\d+)$/.exec(b.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `BRF-${String(max + 1).padStart(3, '0')}`;
}

export const briefings = new Hono();

briefings.get('/', async (c) => {
  const list = await readBriefings();
  // Newest first
  list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
  return c.json({ briefings: list });
});

briefings.get('/:id', async (c) => {
  const list = await readBriefings();
  const b = list.find((x) => x.id === c.req.param('id'));
  if (!b) return c.json({ error: 'not found' }, 404);
  return c.json({ briefing: b });
});

briefings.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const list = await readBriefings();
  const id = nextId(list);
  const briefing: Briefing = {
    id,
    title: body.title ?? `Briefing ${id}`,
    quarter: body.quarter ?? '',
    status: 'draft',
    created_at: new Date().toISOString(),
    script_path: body.script_path ?? null,
    duration_seconds: body.duration_seconds ?? null,
    youtube_url: null,
    youtube_video_id: null,
    thumbnail_url: null,
    render_log: null,
    error: null,
    summary: body.summary ?? null,
  };
  list.push(briefing);
  await writeBriefings(list);
  return c.json({ briefing }, 201);
});

briefings.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const list = await readBriefings();
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return c.json({ error: 'not found' }, 404);
  const allowed = [
    'title', 'quarter', 'status', 'script_path', 'duration_seconds',
    'youtube_url', 'youtube_video_id', 'thumbnail_url', 'render_log',
    'error', 'summary',
  ] as const;
  for (const k of allowed) {
    if (k in body) (list[idx] as any)[k] = body[k];
  }
  await writeBriefings(list);
  return c.json({ briefing: list[idx] });
});

briefings.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const list = await readBriefings();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return c.json({ error: 'not found' }, 404);
  await writeBriefings(next);
  return c.json({ ok: true });
});
