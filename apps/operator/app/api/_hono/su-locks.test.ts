/**
 * Unit tests for the /api/su-locks/hook-health route (file-locking #3).
 * Mounts the router on a fresh Hono app and drives it with synthetic
 * requests — no operator boot, no real HTTP. The route reads the two
 * markers from PAPERCUSP_LOCKS_CACHE_DIR (last-error.json +
 * last-success.json) and derives `healthy` from their ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suLocks } from './su-locks';

let TMP: string;
let app: Hono;
let prev: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'su-locks-route-'));
  prev = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  process.env.PAPERCUSP_LOCKS_CACHE_DIR = TMP;
  app = new Hono();
  app.route('/su-locks', suLocks);
});

afterEach(() => {
  if (prev === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prev;
  rmSync(TMP, { recursive: true, force: true });
});

function writeError(ts: string): void {
  writeFileSync(
    join(TMP, 'last-error.json'),
    JSON.stringify({
      ts,
      handler: 'tool_call',
      phase: 'connect',
      detail: 'operator unreachable',
      operator_url: 'http://operator.test',
    }),
  );
}
function writeSuccess(ts: string): void {
  writeFileSync(join(TMP, 'last-success.json'), JSON.stringify({ ts }));
}

async function getHealth(): Promise<{
  status: number;
  body: {
    healthy: boolean;
    last_success_ts: string | null;
    last_error: Record<string, unknown> | null;
  };
}> {
  const res = await app.fetch(new Request('http://x/su-locks/hook-health'));
  return { status: res.status, body: await res.json() };
}

describe('GET /api/su-locks/hook-health', () => {
  it('healthy=true, both null when no markers exist', async () => {
    const { status, body } = await getHealth();
    expect(status).toBe(200);
    expect(body).toEqual({
      healthy: true,
      last_success_ts: null,
      last_error: null,
    });
  });

  it('healthy=true when only a success marker exists', async () => {
    writeSuccess('2026-05-20T10:00:00Z');
    const { body } = await getHealth();
    expect(body.healthy).toBe(true);
    expect(body.last_success_ts).toBe('2026-05-20T10:00:00Z');
    expect(body.last_error).toBeNull();
  });

  it('healthy=false when only an error marker exists (no success ever)', async () => {
    writeError('2026-05-20T10:00:00Z');
    const { body } = await getHealth();
    expect(body.healthy).toBe(false);
    expect(body.last_error).toMatchObject({
      handler: 'tool_call',
      phase: 'connect',
    });
  });

  it('healthy=false when the error is newer than the last success', async () => {
    writeSuccess('2026-05-20T10:00:00Z');
    writeError('2026-05-20T10:05:00Z');
    const { body } = await getHealth();
    expect(body.healthy).toBe(false);
  });

  it('healthy=true when a success is newer than the last error (recovered)', async () => {
    writeError('2026-05-20T10:00:00Z');
    writeSuccess('2026-05-20T10:05:00Z');
    const { body } = await getHealth();
    expect(body.healthy).toBe(true);
  });

  it('tolerates malformed marker JSON (treats as absent)', async () => {
    writeFileSync(join(TMP, 'last-error.json'), 'not-json');
    writeFileSync(join(TMP, 'last-success.json'), '{bad');
    const { body } = await getHealth();
    expect(body).toEqual({
      healthy: true,
      last_success_ts: null,
      last_error: null,
    });
  });
});
