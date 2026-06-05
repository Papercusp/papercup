/**
 * backups-destructive.test.ts — route coverage for the destructive backup ops
 * (P-013, Phase 2).
 *
 * `POST /backups/{restore,rollback,promote}` are all declared `auth: 'public'`
 * and perform destructive, data-replacing operations (restore-to-clone /
 * in-place, undo-a-promote, promote-clone-to-live). The audit flagged the
 * entire backups group as untested at the route level AND flagged the public
 * posture as a security concern. This test drives the real route definitions
 * in-process (Hono `app.request`), with the backup engine mocked, to pin:
 *   - each route reaches its destructive op with the validated args,
 *   - promote fires the `pre_destructive` snapshot guard first,
 *   - **the public posture**: the routes run with NO auth header (documented),
 *   - input-validation errors currently surface as HTTP 500, not 400.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  wb: {
    restoreToClone: vi.fn(async (a: unknown) => ({ ok: true, mode: 'clone', a })),
    restoreInPlace: vi.fn(async () => ({ ok: true, mode: 'in_place' })),
    rollbackPromote: vi.fn(async () => ({ ok: true, rolledBack: true })),
    promoteRestore: vi.fn(async () => ({ ok: true, promoted: true })),
  },
  triggerSnapshotEvent: vi.fn(async () => {}),
  activeWorkspaceId: vi.fn(() => 'ws'),
}));

vi.mock('../../backup', () => ({
  workspaceBackupFor: vi.fn(() => h.wb),
  triggerSnapshotEvent: h.triggerSnapshotEvent,
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: h.activeWorkspaceId }));
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));
vi.mock('../../auth/require-principal', () => ({
  requirePrincipal: vi.fn(async () => ({
    kind: 'system', slug: 'system', workspaceId: 'ws', trust: 'trusted', capabilities: new Set(['*']),
  })),
  PrincipalCheckError: class extends Error {
    constructor(public status: number, public reason: string) { super(reason); }
  },
}));

import { registerRoute } from '../define-route';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import restoreRoute from '../routes/backups/restore';
import rollbackRoute from '../routes/backups/rollback';
import promoteRoute from '../routes/backups/promote';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appWith(def: any): Hono {
  const app = new Hono();
  registerRoute(app, def);
  return app;
}
// NOTE: no auth header on any request — these routes are auth:'public'.
const post = (body?: unknown) => ({
  method: 'POST',
  ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
});

afterEach(() => vi.clearAllMocks());

describe('destructive backup routes (auth: public)', () => {
  it('POST /backups/restore (clone) reaches restoreToClone with validated args', async () => {
    const res = await appWith(restoreRoute).request('/backups/restore', post({ kopiaSnapshotId: 'snap-1' }));
    expect(res.status).toBe(200);
    expect(h.wb.restoreToClone).toHaveBeenCalledTimes(1);
    expect(h.wb.restoreToClone.mock.calls[0][0]).toMatchObject({ kopiaSnapshotId: 'snap-1', mode: 'clone' });
    expect(h.wb.restoreInPlace).not.toHaveBeenCalled();
  });

  it('POST /backups/restore (in_place) reaches restoreInPlace', async () => {
    const res = await appWith(restoreRoute).request('/backups/restore', post({ kopiaSnapshotId: 'snap-1', mode: 'in_place' }));
    expect(res.status).toBe(200);
    expect(h.wb.restoreInPlace).toHaveBeenCalledTimes(1);
    expect(h.wb.restoreToClone).not.toHaveBeenCalled();
  });

  it('POST /backups/rollback reaches rollbackPromote', async () => {
    const res = await appWith(rollbackRoute).request('/backups/rollback', post({ brokenPath: '/data/broken' }));
    expect(res.status).toBe(200);
    expect(h.wb.rollbackPromote).toHaveBeenCalledWith(expect.objectContaining({ brokenPath: '/data/broken' }));
  });

  it('POST /backups/promote fires the pre_destructive guard, THEN promotes', async () => {
    const res = await appWith(promoteRoute).request('/backups/promote', post({ restoredPath: '/data/restored' }));
    expect(res.status).toBe(200);
    expect(h.triggerSnapshotEvent).toHaveBeenCalledWith('ws', 'pre_destructive', expect.objectContaining({ op: 'promote_restore' }));
    expect(h.wb.promoteRestore).toHaveBeenCalledWith(expect.objectContaining({ restoredPath: '/data/restored' }));
  });

  it('SECURITY POSTURE: a destructive restore runs with NO auth (auth:public)', async () => {
    // No bearer / no principal — the route is public, so the destructive op runs.
    // This pins the audit's finding: any loopback caller can trigger a restore.
    const res = await appWith(restoreRoute).request('/backups/restore', post({ kopiaSnapshotId: 'snap-x' }));
    expect(res.status).toBe(200);
    expect(h.wb.restoreToClone).toHaveBeenCalledTimes(1);
  });

  it('input-validation errors currently surface as HTTP 500 (handler catches Zod)', async () => {
    const res = await appWith(restoreRoute).request('/backups/restore', post({ source: 'x' })); // missing kopiaSnapshotId
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('error');
    expect(h.wb.restoreToClone).not.toHaveBeenCalled();
  });
});
