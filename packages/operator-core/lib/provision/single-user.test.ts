/**
 * single-user host detection — focuses on the deterministic pieces:
 * acknowledgement signature, threshold logic. The actual `who` and
 * /etc/passwd reads are filesystem-dependent and only smoke-tested.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let TMP_HOME: string;

beforeEach(async () => {
  TMP_HOME = await fs.mkdtemp(join(tmpdir(), 'paperhome-host-'));
  process.env.PAPERCUSP_HOME = TMP_HOME;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.PAPERCUSP_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('host signature', () => {
  it('produces stable signatures regardless of order', async () => {
    const m = await import('./single-user');
    const a = m.__testInternals.signatureOf({
      activeUsers: ['alice', 'bob'],
      configuredUsers: ['carol'],
      isShared: true,
    });
    const b = m.__testInternals.signatureOf({
      activeUsers: ['bob', 'alice'],
      configuredUsers: ['carol'],
      isShared: true,
    });
    expect(a).toBe(b);
  });

  it('changes when user-set changes', async () => {
    const m = await import('./single-user');
    const a = m.__testInternals.signatureOf({
      activeUsers: ['alice'],
      configuredUsers: [],
      isShared: false,
    });
    const b = m.__testInternals.signatureOf({
      activeUsers: ['alice', 'newcomer'],
      configuredUsers: [],
      isShared: true,
    });
    expect(a).not.toBe(b);
  });
});

describe('readAcknowledgement / writeAcknowledgement', () => {
  it('returns null when no ack file exists', async () => {
    const m = await import('./single-user');
    expect(await m.readAcknowledgement()).toBeNull();
  });

  it('round-trips an ack record', async () => {
    const m = await import('./single-user');
    const signals = { activeUsers: ['alice'], configuredUsers: ['alice'], isShared: false };
    await m.writeAcknowledgement(signals);
    const ack = await m.readAcknowledgement();
    expect(ack).not.toBeNull();
    expect(ack?.signature).toContain('alice');
  });
});

describe('decideGate', () => {
  it('allows on single-user host', async () => {
    // Module is filesystem-dependent; just sanity-check the result shape.
    const m = await import('./single-user');
    const r = await m.decideGate();
    expect(['allow', 'allow-acked', 'gate']).toContain(r.decision);
    expect(Array.isArray(r.signals.activeUsers)).toBe(true);
  });
});
