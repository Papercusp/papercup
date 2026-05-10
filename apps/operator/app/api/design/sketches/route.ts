/**
 * Design sketches — list + create.
 *
 *   GET  /api/design/sketches?harness=<slug>&feature=<id>&workspace=<id>
 *     → list prior sketches for a feature (most recent first)
 *
 *   POST /api/design/sketches
 *     body: { harness, feature, png, label? }
 *     → store a sketch artifact (kind='sketch') in harness_design_artifacts
 *
 * `png` is a data URL (data:image/png;base64,…). The dataURL goes
 * straight into the JSONB payload; for a real production setup we'd
 * push the bytes to object storage and keep the URL in PG. v0.1 keeps
 * everything inline because the volume is low and queries don't read
 * the bytes.
 *
 * The pane in /design/<slug> calls these endpoints. v0.1 ships the
 * sketch canvas as plain HTML5 canvas; tldraw is a planned upgrade
 * whenever richer shapes are worth the dependency cost. Schema is
 * tldraw-ready (just store the snapshot blob in payload).
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SketchPayload {
  png: string;
  label?: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const harness = url.searchParams.get('harness') ?? '';
  const feature = url.searchParams.get('feature') ?? '';
  const workspace = url.searchParams.get('workspace') ?? 'default';
  if (!harness || !feature) {
    return NextResponse.json(
      { ok: false, error: 'harness and feature query params required' },
      { status: 400 },
    );
  }
  try {
    const { sql } = getOrgPg();
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
      return await tx`
        SELECT id, payload, metadata, created_ts
          FROM harness_shared.harness_design_artifacts
         WHERE harness_slug = ${harness}
           AND feature_id   = ${feature}
           AND kind         = 'sketch'
         ORDER BY created_ts DESC
         LIMIT 100
      `;
    });
    return NextResponse.json({
      ok: true,
      sketches: rows.map((r) => ({
        id: r.id,
        label: (r.payload as SketchPayload | null)?.label ?? null,
        png: (r.payload as SketchPayload | null)?.png ?? null,
        createdTs: r.created_ts == null ? null : Number(r.created_ts),
        metadata: r.metadata ?? {},
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'pg_error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

const MAX_PNG_BYTES = 5 * 1024 * 1024; // 5 MB upper bound on data URL size

export async function POST(req: Request) {
  let body: { harness?: string; feature?: string; png?: string; label?: string; workspace?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const harness = body.harness?.trim();
  const feature = body.feature?.trim();
  const png = body.png?.trim();
  const workspace = body.workspace?.trim() || 'default';
  if (!harness || !feature || !png) {
    return NextResponse.json(
      { ok: false, error: 'harness, feature, and png required' },
      { status: 400 },
    );
  }
  if (!png.startsWith('data:image/png;base64,')) {
    return NextResponse.json(
      { ok: false, error: 'png must be a data:image/png;base64,… URL' },
      { status: 400 },
    );
  }
  if (png.length > MAX_PNG_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'png too large', detail: `max ${MAX_PNG_BYTES} bytes` },
      { status: 413 },
    );
  }
  try {
    const id = `sketch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const payload: SketchPayload = { png, label: body.label };
    const { sql } = getOrgPg();
    // Stringify ourselves + cast to jsonb in SQL — works around a
    // postgres-js encoder edge case where tx.json(...) on payloads
    // containing very long string fields (the data URL) produces
    // 'The "string" argument must be of type string' from the inner
    // util.format call.
    const payloadJson = JSON.stringify(payload);
    const metadataJson = JSON.stringify({ source: 'design-tab-sketch' });
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspace]);
      await tx`
        INSERT INTO harness_shared.harness_design_artifacts
          (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${id}, ${harness}, ${feature}, 'sketch',
                ${payloadJson}::jsonb,
                ${metadataJson}::jsonb,
                ${now})
      `;
    });
    return NextResponse.json({ ok: true, id, createdTs: now });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: 'pg_error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
