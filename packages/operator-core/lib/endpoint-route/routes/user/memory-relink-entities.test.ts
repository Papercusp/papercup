/**
 * memory-relink-entities.test.ts — EI-10218: POST /api/user/memory/relink-entities
 * (the entity re-link backfill route) must be SAFE-BY-DEFAULT.
 *
 * Unlike the idempotent re-embed, this route DELETES junk entity rows and
 * re-links memories — an irreversible live-data mutation. So the route's own
 * contract (beyond just calling relinkEntities) is: `dryRun` defaults TRUE, only
 * an explicit `false` mutates; a body-less / unparseable POST is a safe
 * report-only dry-run (never an accidental mutation); numeric/scope inputs are
 * validated + clamped; the kill-switch surfaces as 409.
 *
 * Run: cd packages/operator-core && npx vitest run lib/endpoint-route/routes/user/memory-relink-entities.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (def: unknown) => def }));
vi.mock('../../../auth', () => ({
  getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1', display_name: 'Test User' })),
}));
vi.mock('../../../memory/relink-entities', () => ({
  relinkEntities: vi.fn(async () => ({
    affectedMemories: 3,
    memoriesRelinked: 3,
    junkDeleted: 5,
    errors: 0,
    dryRun: false,
    junkRemaining: 0,
    durationMs: 12,
  })),
}));

import route from './memory-relink-entities';
import { relinkEntities } from '../../../memory/relink-entities';

type Route = { method: string; path: string; handler: (req: Request) => Promise<Response> };
const def = route as unknown as Route;

const req = (body: unknown, raw?: string): Request =>
  new Request('http://localhost/api/user/memory/relink-entities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /user/memory/relink-entities — safe-by-default (EI-10218)', () => {
  it('registers as a loopback POST at the mirror path with the 600s budget', () => {
    expect(def.method).toBe('POST');
    expect(def.path).toBe('/user/memory/relink-entities');
    expect((route as unknown as { auth: string }).auth).toBe('loopback');
    expect((route as unknown as { timeoutSec: number }).timeoutSec).toBe(600);
  });

  it('a body-less POST defaults to a DRY RUN (never an accidental mutation)', async () => {
    const res = await def.handler(req({}));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true });
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('an UNPARSEABLE body is a safe dry-run, not a 400 (the fact is never mutated by malformed input)', async () => {
    const res = await def.handler(req(undefined, '{ not json'));
    expect(res.status).toBe(200);
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('only an EXPLICIT dryRun:false mutates', async () => {
    await def.handler(req({ dryRun: false }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }));
  });

  it('dryRun:true is honored explicitly too', async () => {
    await def.handler(req({ dryRun: true }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('a non-boolean-false dryRun (e.g. the string "false") stays a DRY RUN — only the boolean false mutates', async () => {
    await def.handler(req({ dryRun: 'false' }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('rejects a non-positive / non-integer maxMemories with 400 and never calls the backfill', async () => {
    for (const bad of [0, -5, 2.5, 'abc']) {
      vi.clearAllMocks();
      const res = await def.handler(req({ maxMemories: bad }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: 'invalid_maxMemories' });
      expect(relinkEntities).not.toHaveBeenCalled();
    }
  });

  it('clamps an over-cap maxMemories to the request-budget ceiling (5000)', async () => {
    await def.handler(req({ maxMemories: 99999, dryRun: false }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ maxMemories: 5000, dryRun: false }));
  });

  it('passes a valid maxMemories through unchanged', async () => {
    await def.handler(req({ maxMemories: 250 }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ maxMemories: 250 }));
  });

  it('rejects an empty-string userId with 400', async () => {
    const res = await def.handler(req({ userId: '' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_userId' });
    expect(relinkEntities).not.toHaveBeenCalled();
  });

  it('passes a valid userId scope through', async () => {
    await def.handler(req({ userId: 'harness:papercusp' }));
    expect(relinkEntities).toHaveBeenCalledWith(expect.objectContaining({ userId: 'harness:papercusp' }));
  });

  it('surfaces the kill-switch (relink_disabled) as 409, not 500', async () => {
    vi.mocked(relinkEntities).mockRejectedValueOnce(new Error('relink_disabled'));
    const res = await def.handler(req({ dryRun: false }));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'relink_failed', message: 'relink_disabled' });
  });

  it('any other backfill error is a 500', async () => {
    vi.mocked(relinkEntities).mockRejectedValueOnce(new Error('pg down'));
    const res = await def.handler(req({ dryRun: false }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ error: 'relink_failed', message: 'pg down' });
  });

  it('echoes the backfill result on success', async () => {
    const res = await def.handler(req({ dryRun: false }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, junkDeleted: 5, memoriesRelinked: 3, junkRemaining: 0 });
  });
});
