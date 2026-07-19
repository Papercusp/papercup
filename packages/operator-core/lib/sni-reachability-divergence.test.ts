/**
 * sni-reachability-divergence.test.ts — EI-16742 regression guard.
 *
 * Locks the comparator's core distinction: same-IP, control-succeeds /
 * target-hangs is the local-SNI-filter signature; a failing control makes
 * the comparison inconclusive rather than a false "filtered" finding; both
 * succeeding is a clean "reachable" verdict.
 */
import { describe, it, expect } from 'vitest';
import { evaluateSniReachability } from './sni-reachability-divergence';

describe('evaluateSniReachability (EI-16742)', () => {
  it('the live incident signature: control completes, target hangs, on the same IP', () => {
    const v = evaluateSniReachability({
      controlSni: 'github.com',
      control: { handshakeCompleted: true },
      targetSni: 'papercusp.com',
      target: { handshakeCompleted: false },
    });
    expect(v.classification).toBe('sni-filtered-locally');
    expect(v.reason).toMatch(/EI-16742/);
    expect(v.reason).toMatch(/papercusp\.com/);
    expect(v.reason).toMatch(/github\.com/);
  });

  it('both handshakes complete — reachable, no filtering evidence', () => {
    const v = evaluateSniReachability({
      controlSni: 'github.com',
      control: { handshakeCompleted: true },
      targetSni: 'papercusp.com',
      target: { handshakeCompleted: true },
    });
    expect(v.classification).toBe('reachable');
  });

  it('control itself fails — inconclusive, never reported as a filter finding', () => {
    const v = evaluateSniReachability({
      controlSni: 'github.com',
      control: { handshakeCompleted: false },
      targetSni: 'papercusp.com',
      target: { handshakeCompleted: false },
    });
    expect(v.classification).toBe('inconclusive');
    expect(v.reason).toMatch(/control SNI/);
  });

  it('control fails but target somehow succeeds — still inconclusive (no filter signature to report)', () => {
    const v = evaluateSniReachability({
      controlSni: 'github.com',
      control: { handshakeCompleted: false },
      targetSni: 'papercusp.com',
      target: { handshakeCompleted: true },
    });
    expect(v.classification).toBe('inconclusive');
  });

  it('a genuinely down target never trips the filter path when the control also fails', () => {
    // A real, broader outage means the control probe fails too — must not be
    // conflated with the "control fine, target hangs" filter signature.
    const v = evaluateSniReachability({
      controlSni: 'github.com',
      control: { handshakeCompleted: false },
      targetSni: 'papercusp.com',
      target: { handshakeCompleted: false },
    });
    expect(v.classification).not.toBe('sni-filtered-locally');
  });

  it('reason text names both hostnames and steers toward an external vantage', () => {
    const v = evaluateSniReachability({
      controlSni: 'www.cloudflare.com',
      control: { handshakeCompleted: true },
      targetSni: 'flags.papercuspai.com',
      target: { handshakeCompleted: false },
    });
    expect(v.classification).toBe('sni-filtered-locally');
    expect(v.reason).toMatch(/WebFetch/);
    expect(v.reason).toMatch(/flags\.papercuspai\.com/);
  });
});
