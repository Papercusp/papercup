/**
 * Tests for /api/provision/run.
 *
 * Verifies missing-param rejection, unknown-plugin rejection, and a
 * happy-path setup invocation against a real fixture plugin in a temp
 * dir. The runner itself is sandboxed by setting PAPERCUSP_DISABLE_SANDBOX.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-provrun-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  process.env.PAPERCUSP_DISABLE_SANDBOX = '1';
  vi.resetModules();
  // Fail PG path so the runner uses process-only mode.
  vi.doMock('@restart/db-org', () => ({
    getOrgPg: () => ({ sql: () => { throw new Error('pg-not-available'); } }),
  }));
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  delete process.env.PAPERCUSP_DISABLE_SANDBOX;
  vi.doUnmock('@restart/db-org');
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

async function postJson(body: unknown) {
  const { POST } = await import('./route');
  return POST(new Request('http://x/api/provision/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function makeFixturePlugin(slug: string, manifest: Record<string, unknown>, scriptContent?: string) {
  const dir = join(TMP_HOME, 'global-plugins', slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest));
  if (scriptContent) {
    await fs.mkdir(join(dir, 'provision'), { recursive: true });
    await fs.writeFile(join(dir, 'provision/setup.sh'), scriptContent, { mode: 0o755 });
  }
}

describe('POST /api/provision/run', () => {
  it('rejects missing required params', async () => {
    const r = await postJson({});
    expect(r.status).toBe(400);
  });

  it('rejects invalid phase', async () => {
    const r = await postJson({ harness: 'h', plugin: 'p', phase: 'eat-cake' });
    expect(r.status).toBe(400);
  });

  it('returns 404 when plugin is not installed', async () => {
    const r = await postJson({ harness: 'h', plugin: 'never-installed', phase: 'setup' });
    expect(r.status).toBe(404);
  });

  it('rejects when plugin has no provision block', async () => {
    await makeFixturePlugin('no-prov', {
      kind: 'plugin', name: 'no-prov', version: '1.0.0', papercusp: '^0.1.0', capabilities: [],
    });
    const r = await postJson({ harness: 'h', plugin: 'no-prov', phase: 'setup' });
    expect(r.status).toBe(400);
  });

  it('runs setup happy path and returns ok=true', async () => {
    await makeFixturePlugin(
      'happy',
      {
        kind: 'plugin', name: 'happy', version: '1.0.0', papercusp: '^0.1.0',
        capabilities: [],
        publisher: 'test',
        provision: { setup: { path: 'provision/setup.sh', timeoutSec: 10 } },
      },
      '#!/usr/bin/env bash\nexit 0\n',
    );
    const r = await postJson({
      harness: 'h-test',
      plugin: 'happy',
      phase: 'setup',
      consentConfirmed: true,
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.exitCode).toBe(0);
  });

  it('returns ok=false with consent error when consentConfirmed is false', async () => {
    await makeFixturePlugin(
      'gated',
      {
        kind: 'plugin', name: 'gated', version: '1.0.0', papercusp: '^0.1.0',
        capabilities: [], publisher: 'test',
        provision: { setup: { path: 'provision/setup.sh' } },
      },
      '#!/usr/bin/env bash\nexit 0\n',
    );
    const r = await postJson({
      harness: 'h', plugin: 'gated', phase: 'setup', consentConfirmed: false,
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain('consent');
  });
});
