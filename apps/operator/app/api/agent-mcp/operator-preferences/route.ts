/**
 * GET    /api/agent-mcp/operator-preferences           — list entries (filterable)
 * POST   /api/agent-mcp/operator-preferences           — append a new entry
 * DELETE /api/agent-mcp/operator-preferences?key=…     — remove by key
 *
 * The substrate-prompt + parser refer to provenance tags directly; this
 * route just curates the file. Callers from the panel: dismiss-with-reason
 * and edit-then-dispatch (Phase 4a) build the entry and POST.
 */

import { NextRequest } from 'next/server';
import {
  appendPreferenceEntry,
  listPreferenceEntries,
  removePreferenceEntry,
} from '@/lib/operator-preferences';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ entries: await listPreferenceEntries() });
}

export async function POST(req: NextRequest) {
  let body: { entry?: unknown } = {};
  try {
    body = (await req.json()) as { entry?: unknown };
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }
  const entry = typeof body.entry === 'string' ? body.entry.trim() : '';
  if (!entry) return new Response('entry required', { status: 400 });
  await appendPreferenceEntry(entry);
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const key = new URL(req.url).searchParams.get('key');
  if (!key) return new Response('key required', { status: 400 });
  const removed = await removePreferenceEntry(key);
  if (!removed) return new Response('not found', { status: 404 });
  return Response.json({ ok: true });
}
