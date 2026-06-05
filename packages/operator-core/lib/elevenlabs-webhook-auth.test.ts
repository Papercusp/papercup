import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyElevenLabsSignature } from './elevenlabs-webhook-auth';

const SECRET = 'test-secret-1234567890';

function sign(body: string, ts: number, secret = SECRET): string {
  const tSec = Math.floor(ts / 1000);
  const hex = createHmac('sha256', secret).update(`${tSec}.${body}`).digest('hex');
  return `t=${tSec},v0=${hex}`;
}

const NOW = 1_700_000_000_000;

beforeEach(() => { process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET; });
afterEach(() => { delete process.env.ELEVENLABS_WEBHOOK_SECRET; });

describe('verifyElevenLabsSignature', () => {
  it('accepts a valid signature within skew window', () => {
    const body = '{"hello":"world"}';
    const r = verifyElevenLabsSignature({
      rawBody: body,
      signatureHeader: sign(body, NOW),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects when secret is set but no header arrived', () => {
    const r = verifyElevenLabsSignature({ rawBody: '{}', signatureHeader: null, now: NOW });
    expect(r).toEqual({ ok: false, reason: 'missing-header' });
  });

  it('rejects malformed header', () => {
    const r = verifyElevenLabsSignature({ rawBody: '{}', signatureHeader: 'gibberish', now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('malformed-header');
  });

  it('rejects stale timestamps (> 5 min skew)', () => {
    const body = '{"x":1}';
    const oldTs = NOW - 10 * 60_000;
    const r = verifyElevenLabsSignature({
      rawBody: body,
      signatureHeader: sign(body, oldTs),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });

  it('rejects when HMAC does not match (wrong secret)', () => {
    const body = '{"x":1}';
    const wrongSig = sign(body, NOW, 'different-secret');
    const r = verifyElevenLabsSignature({
      rawBody: body,
      signatureHeader: wrongSig,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects when body is altered after signing', () => {
    const original = '{"x":1}';
    const altered  = '{"x":2}';
    const r = verifyElevenLabsSignature({
      rawBody: altered,
      signatureHeader: sign(original, NOW),
      now: NOW,
    });
    expect(r).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('skips verification (dev mode) when secret is unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    const r = verifyElevenLabsSignature({ rawBody: '{}', signatureHeader: null, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('no-secret-dev');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
