/**
 * GET / POST /api/profile — read / update the operator profile.
 * Ported from app/api/profile/route.ts. `auth: 'public'`.
 */
import { readProfile, writeProfile } from '@/lib/session';
import { defineTool } from '@papercusp/agent-mcp';

const ALLOWED = [
  'email',
  'display_name',
  'default_project_dir',
  'preferred_models',
  'theme',
  'auto_scan',
  'auto_accept',
  'toast_last_seen_ms',
];

export default [
  defineTool({
    method: 'GET',
    path: '/profile',
    auth: 'public',
    async handler() {
      return Response.json(await readProfile());
    },
  }),
  defineTool({
    method: 'POST',
    path: '/profile',
    auth: 'public',
    async handler(req) {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid body' }, { status: 400 });
      }
      const existing = await readProfile();
      const next = { ...existing, ...body } as Record<string, unknown>;
      for (const k of Object.keys(next)) {
        if (!ALLOWED.includes(k) && k !== 'updated_at') delete next[k];
      }
      return Response.json(await writeProfile(next));
    },
  }),
];
