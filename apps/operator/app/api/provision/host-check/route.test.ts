/**
 * Tests for /api/provision/host-check.
 *
 * Verifies the GET path returns a decision shape, POST acknowledges the
 * current host signature, and the smoke-test query shorthand returns a
 * sandbox driver report.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-hostcheck-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('/api/provision/host-check', () => {
  it('GET returns a decision shape', async () => {
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/provision/host-check'));
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(['allow', 'allow-acked', 'gate']).toContain(body.decision);
    expect(Array.isArray(body.signals.activeUsers)).toBe(true);
  });

  it('GET ?smokeTest=1 returns sandbox driver report', async () => {
    const { GET } = await import('./route');
    const r = await GET(new Request('http://x/api/provision/host-check?smokeTest=1'));
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.smokeTest).toBeDefined();
    expect(body.smokeTest.driver).toBe('none');
    // ok=false because driver=none and sandbox is disabled.
    expect(body.smokeTest.ok).toBe(false);
  });

  it('POST writes acknowledgement', async () => {
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/provision/host-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acknowledge: true }),
      }),
    );
    expect((await r.json()).ok).toBe(true);
    // Ack file should exist.
    const ack = await fs.readFile(join(TMP_HOME, 'single-user-acknowledged'), 'utf8');
    expect(JSON.parse(ack).signature).toBeDefined();
  });

  it('POST without acknowledge=true returns 400', async () => {
    const { POST } = await import('./route');
    const r = await POST(
      new Request('http://x/api/provision/host-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(r.status).toBe(400);
  });
});
