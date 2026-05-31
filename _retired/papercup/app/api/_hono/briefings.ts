/**
 * Papercup briefings API. Tracks AI-generated shareholder-meeting videos.
 *
 * Storage:
 *   papercup_shared.briefings (Postgres) — canonical, Zero-synced.
 *   ~/.restart-org/briefings.json — derived snapshot tagged
 *     `derivedFromPg: true` for tools that want a flat file.
 *
 * Lifecycle states (in order):
 *   draft → rendering → rendered → uploading → uploaded
 *   any stage may transition to: failed
 */
import { Hono } from 'hono';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';

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

function rowToBriefing(r: any): Briefing {
  return {
    id: r.id,
    title: r.title,
    quarter: r.quarter ?? '',
    status: r.status,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    script_path: r.script_path ?? null,
    duration_seconds: r.duration_seconds ?? null,
    youtube_url: r.youtube_url ?? null,
    youtube_video_id: r.youtube_video_id ?? null,
    thumbnail_url: r.thumbnail_url ?? null,
    render_log: r.render_log ?? null,
    error: r.error ?? null,
    summary: r.summary ?? null,
  };
}

async function readBriefings(): Promise<Briefing[]> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT * FROM papercup_shared.briefings
    ORDER BY created_at DESC
  `;
  return rows.map(rowToBriefing);
}

async function writeJsonSnapshot(list: Briefing[]): Promise<void> {
  // Derived snapshot — PG is canonical. Tagged so downstream tools can
  // recognise it as derived rather than authoritative.
  await mkdir(dirname(BRIEFINGS_PATH), { recursive: true });
  await writeFile(
    BRIEFINGS_PATH,
    JSON.stringify({ derivedFromPg: true, briefings: list }, null, 2),
    'utf8',
  );
}

async function nextId(): Promise<string> {
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT id FROM papercup_shared.briefings
    WHERE id ~ '^BRF-[0-9]+$'
  `;
  let max = 0;
  for (const r of rows) {
    const m = /^BRF-(\d+)$/.exec(r.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `BRF-${String(max + 1).padStart(3, '0')}`;
}

export const briefings = new Hono();

briefings.get('/', async (c) => {
  const list = await readBriefings();
  return c.json({ briefings: list });
});

briefings.get('/:id', async (c) => {
  const { sql } = getOrgPg();
  const id = c.req.param('id');
  const rows = await sql`
    SELECT * FROM papercup_shared.briefings WHERE id = ${id} LIMIT 1
  `;
  if (rows.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ briefing: rowToBriefing(rows[0]) });
});

briefings.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const { sql } = getOrgPg();
  const id = await nextId();
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
  await sql`
    INSERT INTO papercup_shared.briefings
      (id, title, quarter, status, created_at, script_path, duration_seconds, summary)
    VALUES (${briefing.id}, ${briefing.title}, ${briefing.quarter}, ${briefing.status},
            ${briefing.created_at}, ${briefing.script_path}, ${briefing.duration_seconds},
            ${briefing.summary})
  `;
  await writeJsonSnapshot(await readBriefings());
  return c.json({ briefing }, 201);
});

briefings.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({} as any));
  const { sql } = getOrgPg();
  const allowed = [
    'title', 'quarter', 'status', 'script_path', 'duration_seconds',
    'youtube_url', 'youtube_video_id', 'thumbnail_url', 'render_log',
    'error', 'summary',
  ] as const;
  const updates: Record<string, any> = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];
  if (Object.keys(updates).length === 0) {
    const rows = await sql`SELECT * FROM papercup_shared.briefings WHERE id = ${id} LIMIT 1`;
    if (rows.length === 0) return c.json({ error: 'not found' }, 404);
    return c.json({ briefing: rowToBriefing(rows[0]) });
  }
  const rows = await sql`
    UPDATE papercup_shared.briefings
    SET ${sql(updates)}
    WHERE id = ${id}
    RETURNING *
  `;
  if (rows.length === 0) return c.json({ error: 'not found' }, 404);
  await writeJsonSnapshot(await readBriefings());
  return c.json({ briefing: rowToBriefing(rows[0]) });
});

briefings.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const { sql } = getOrgPg();
  const rows = await sql`DELETE FROM papercup_shared.briefings WHERE id = ${id} RETURNING id`;
  if (rows.length === 0) return c.json({ error: 'not found' }, 404);
  await writeJsonSnapshot(await readBriefings());
  return c.json({ ok: true });
});
