/**
 * Smoke test for /api/provision/state.
 *
 * Verifies missing-param rejection, default-state shape, and audit-log
 * inclusion when the limit param is honored.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-provstate-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('GET /api/provision/state', () => {
  it('rejects missing harness/plugin params', async () => {
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/provision/state'));
    expect(r.status).toBe(400);
  });

  it('returns default state when no provision has run', async () => {
    const { GET } = await import('./route');
    const r = await GET(
      new Request('http://x/api/provision/state?harness=h&plugin=p'),
    );
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.state.hashes).toBeNull();
    expect(body.state.createdResources).toEqual([]);
    expect(body.state.setupFailed).toBe(false);
    expect(body.audit).toEqual([]);
  });

  it('returns audit entries up to the requested limit', async () => {
    const auditMod = await import('@/lib/provision/audit-log');
    for (let i = 0; i < 10; i++) {
      await auditMod.appendAudit('h', 'p', { kind: 'script-output', data: { n: i } });
    }
    const { GET } = await import('./route');
    const r = await GET(
      new Request('http://x/api/provision/state?harness=h&plugin=p&auditLimit=3'),
    );
    const body = await r.json();
    expect(body.audit).toHaveLength(3);
    // Most recent come last; the limited slice is the trailing 3.
    expect(body.audit[2].data.n).toBe(9);
  });
});
