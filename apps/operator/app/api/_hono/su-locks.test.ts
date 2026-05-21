/**
 * Unit tests for the /api/su-locks/hook-health route (file-locking #3).
 * Mounts the router on a fresh Hono app and drives it with synthetic
 * requests — no operator boot, no real HTTP. The route just reads
 * ~/.papercusp/locks-cache/hook-health.json (overridable via
 * PAPERCUSP_HOOK_HEALTH_PATH) and derives an `ok` boolean from the
 * last_ok_ts / last_error_ts ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suLocks } from './su-locks';

let TMP: string;
let healthPath: string;
let app: Hono;
let prev: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'su-locks-route-'));
  healthPath = join(TMP, 'hook-health.json');
  prev = process.env.PAPERCUSP_HOOK_HEALTH_PATH;
  process.env.PAPERCUSP_HOOK_HEALTH_PATH = healthPath;
  app = new Hono();
  app.route('/su-locks', suLocks);
});

afterEach(() => {
  if (prev === undefined) delete process.env.PAPERCUSP_HOOK_HEALTH_PATH;
  else process.env.PAPERCUSP_HOOK_HEALTH_PATH = prev;
  rmSync(TMP, { recursive: true, force: true });
});

async function getHealth(): Promise<{
  status: number;
  body: { ok: boolean; record: Record<string, unknown> | null };
}> {
  const res = await app.fetch(new Request('http://x/su-locks/hook-health'));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/su-locks/hook-health', () => {
  it('reports ok=true with record=null when the marker file is missing', async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, record: null });
  });

  it('reports ok=true with record=null when the marker is malformed JSON', async () => {
    writeFileSync(healthPath, 'not-json');
    const { body } = await getHealth();
    expect(body).toEqual({ ok: true, record: null });
  });

  it('reports ok=true when last_ok_ts is the only signal', async () => {
    writeFileSync(
      healthPath,
      JSON.stringify({ last_ok_ts: '2026-05-20T10:00:00Z' }),
    );
    const { body } = await getHealth();
    expect(body.ok).toBe(true);
    expect(body.record).toMatchObject({ last_ok_ts: '2026-05-20T10:00:00Z' });
  });

  it('reports ok=false when last_error_ts is the only signal', async () => {
    writeFileSync(
      healthPath,
      JSON.stringify({
        last_error_ts: '2026-05-20T10:00:00Z',
        last_error_kind: 'operator_unreachable',
      }),
    );
    const { body } = await getHealth();
    expect(body.ok).toBe(false);
    expect(body.record).toMatchObject({
      last_error_kind: 'operator_unreachable',
    });
  });

  it('reports ok=false when last_error_ts is more recent than last_ok_ts', async () => {
    writeFileSync(
      healthPath,
      JSON.stringify({
        last_ok_ts: '2026-05-20T10:00:00Z',
        last_error_ts: '2026-05-20T10:05:00Z',
        last_error_kind: 'operator_unreachable',
      }),
    );
    const { body } = await getHealth();
    expect(body.ok).toBe(false);
  });

  it('reports ok=true when last_ok_ts is more recent than last_error_ts (recovered)', async () => {
    writeFileSync(
      healthPath,
      JSON.stringify({
        last_ok_ts: '2026-05-20T10:05:00Z',
        last_error_ts: '2026-05-20T10:00:00Z',
        last_error_kind: 'operator_unreachable',
      }),
    );
    const { body } = await getHealth();
    expect(body.ok).toBe(true);
  });
});
