import { describe, expect, it, vi } from 'vitest';
import { capturePublicManualFailure, withPublicManualFailureEvidence } from './public-manual-failure-evidence';

describe('hosted manual failure evidence', () => {
  it('captures the assertion failure before cleanup can revoke its session', async () => {
    const order: string[] = [];
    const failure = new Error('selected workspace missing');
    await expect(withPublicManualFailureEvidence(
      async () => { order.push('assertion'); throw failure; },
      async () => { order.push('capture with live session'); },
      async () => { order.push('revoke session'); },
    )).rejects.toBe(failure);
    expect(order).toEqual(['assertion', 'capture with live session', 'revoke session']);
  });

  it('retains the original assertion when diagnostics are unavailable and still cleans up', async () => {
    const failure = new Error('actual browser assertion');
    const cleanup = vi.fn(async () => {});
    await expect(withPublicManualFailureEvidence(
      async () => { throw failure; }, async () => { throw new Error('page closed'); }, cleanup,
    )).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not collect failure evidence for a passing journey', async () => {
    const capture = vi.fn(async () => {});
    const cleanup = vi.fn(async () => {});
    expect(await withPublicManualFailureEvidence(async () => 'passed', capture, cleanup)).toBe('passed');
    expect(capture).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('records the document before probes and excludes credential and resource payloads', async () => {
    const order: string[] = [];
    const attachments: Array<{ name: string; body: Buffer }> = [];
    const page = {
      evaluate: async () => { order.push('document'); return { slots: [{ key: 'workspaces', hidden: false }] }; },
      screenshot: async () => { order.push('screenshot'); return Buffer.from('png'); },
      request: { get: async (url: string) => {
        order.push('probe');
        return { status: () => 200, json: async () => ({
          session: { sessionId: 'secret-session', organizationId: 'private-tenant' },
          apps: [{ kind: 'workspaces', enabled: true }], rows: [{ secret: 'private-resource' }],
          token: 'secret-token', cookie: 'secret-cookie', url,
        }) };
      } },
    } as unknown as Parameters<typeof capturePublicManualFailure>[0];
    const info = { attach: async (name: string, opts: { body?: Buffer }) => { attachments.push({ name, body: opts.body! }); } };
    await capturePublicManualFailure(page, info, 'https://localhost:4392');
    expect(order.slice(0, 2)).toEqual(['document', 'screenshot']);
    const probes = JSON.parse(attachments.find(a => a.name === 'manual-failure-probes-before-cleanup')!.body.toString());
    expect(probes.probes.map((p: { status: number }) => p.status)).toEqual([200, 200, 200]);
    expect(probes.probes[0].authenticated).toBe(true);
    expect(probes.probes[1].workspaceAppEnabled).toBe(true);
    expect(probes.probes[2].rowsPresent).toBe(true);
    expect(JSON.stringify(probes)).not.toMatch(/secret-session|private-tenant|private-resource|secret-token|secret-cookie/);
  });
});
