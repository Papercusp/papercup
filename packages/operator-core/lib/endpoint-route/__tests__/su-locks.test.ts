/**
 * Unit tests for GET /api/su-locks/hook-health (file-locking #3).
 *
 * Migrated from `app/api/_hono/su-locks.test.ts` when the route moved
 * off the legacy Hono sub-app onto `defineTool` (Phase E13,
 * endpoint-unification-2026-05-21). Drives the route handler directly
 * with a hand-built `RouteContext` — no Hono app, no route-stack. The
 * route reads `last-error.json` / `last-success.json` from
 * `PAPERCUSP_LOCKS_CACHE_DIR` and derives `healthy` from their ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RouteContext } from '../define-route';
import hookHealth from '../routes/su-locks/hook-health';

let TMP: string;
let prev: string | undefined;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'su-locks-route-'));
  prev = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  process.env.PAPERCUSP_LOCKS_CACHE_DIR = TMP;
});

afterEach(() => {
  if (prev === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prev;
  rmSync(TMP, { recursive: true, force: true });
});

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

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
    last_decision: Record<string, unknown> | null;
    last_request_defect: Record<string, unknown> | null;
  };
}> {
  const res = await Promise.resolve(
    hookHealth.handler(new Request('http://x/api/su-locks/hook-health'), CTX),
  );
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
      last_decision: null,
      last_request_defect: null,
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
    expect(body.last_error).toMatchObject({ handler: 'tool_call', phase: 'connect' });
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
      last_decision: null,
      last_request_defect: null,
    });
  });

  it('surfaces a request defect independently from the shared healthy signal', async () => {
    writeSuccess('2026-08-12T04:00:00Z');
    writeFileSync(
      join(TMP, 'last-request-defect.json'),
      JSON.stringify({
        ts: '2026-08-12T04:01:00Z',
        handler: 'tool_call',
        detail: 'invalid locks:acquire request',
        count: 3,
        operator_url: 'http://operator.test',
      }),
    );

    const { body } = await getHealth();
    expect(body.healthy).toBe(true);
    expect(body.last_request_defect).toMatchObject({
      handler: 'tool_call',
      detail: 'invalid locks:acquire request',
      count: 3,
    });
  });

  it('surfaces the last automatic acquire decision for lock observability', async () => {
    writeFileSync(join(TMP, 'last-decision.json'), JSON.stringify({
      ts: '2026-07-13T08:00:00Z',
      decision: 'granted',
      owner: 'su-session',
      tool: 'apply_patch',
      paths: ['@external/home/.config/mimeapps.list'],
      lock_id: 'L-1',
    }));
    const { body } = await getHealth();
    expect(body.last_decision).toMatchObject({
      decision: 'granted',
      owner: 'su-session',
      paths: ['@external/home/.config/mimeapps.list'],
    });
  });
});
