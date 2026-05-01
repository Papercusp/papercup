/**
 * Tests for /api/provision/consent.
 *
 * Verifies record + check + revoke through the HTTP surface.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-consent-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

async function postJson(body: unknown) {
  const { POST } = await import('./route');
  return POST(new Request('http://x/api/provision/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

async function getQuery(query: string) {
  const { GET } = await import('./route');
  return GET(new Request(`http://x/api/provision/consent?${query}`));
}

describe('/api/provision/consent', () => {
  it('rejects missing required params on POST', async () => {
    const r = await postJson({});
    expect(r.status).toBe(400);
  });

  it('records trust, then check returns trusted=true', async () => {
    const post = await postJson({
      publisher: '@papercupai',
      plugin: 'aws-lambda',
      scriptHash: 'sha256:s1',
      publisherKeyFingerprint: 'fp1',
    });
    expect((await post.json()).ok).toBe(true);

    const get = await getQuery(
      'publisher=%40papercupai&plugin=aws-lambda&scriptHash=sha256:s1&fingerprint=fp1',
    );
    const body = await get.json();
    expect(body.result.trusted).toBe(true);
  });

  it('check returns no-trust for unrecorded plugin', async () => {
    const get = await getQuery(
      'publisher=foo&plugin=bar&scriptHash=h&fingerprint=fp',
    );
    const body = await get.json();
    expect(body.result.trusted).toBe(false);
    expect(body.result.reason).toBe('no-trust');
  });

  it('revoke removes trust', async () => {
    await postJson({
      publisher: 'X', plugin: 'Y',
      scriptHash: 'sha256:s1',
      publisherKeyFingerprint: 'fp1',
    });
    const revoke = await postJson({ publisher: 'X', plugin: 'Y', revoke: true });
    expect((await revoke.json()).ok).toBe(true);
    const get = await getQuery('publisher=X&plugin=Y&scriptHash=sha256:s1&fingerprint=fp1');
    const body = await get.json();
    expect(body.result.trusted).toBe(false);
    expect(body.result.reason).toBe('no-trust');
  });

  it('records dev install marker', async () => {
    await postJson({
      publisher: 'L', plugin: 'M',
      scriptHash: 'sha256:s1',
      publisherKeyFingerprint: 'fp-dev',
      dev: true,
    });
    const trustMod = await import('@/lib/provision/trust-store');
    const store = await trustMod.readTrustStore();
    const entry = store.entries.find((e) => e.publisher === 'L' && e.plugin === 'M');
    expect(entry?.dev).toBe(true);
  });
});
