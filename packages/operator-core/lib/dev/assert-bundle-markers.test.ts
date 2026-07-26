/**
 * assert-bundle-markers.test.ts — regression for EI-18683847182779973: a stale
 * pre-built bundle (missing a diagnostic patch's instrumentation) must be
 * caught LOUDLY at launch, not silently read as a falsy `undefined`.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundleContainsMarkers, assertBundleContainsMarkers } from './assert-bundle-markers';

let root: string | null = null;
function bundleFile(contents: string): string {
  root = mkdtempSync(join(tmpdir(), 'bundle-marker-test-'));
  const p = join(root, 'serve.mjs');
  writeFileSync(p, contents);
  return p;
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('checkBundleContainsMarkers', () => {
  it('reports ok:true, missing:[] when every marker is present', () => {
    const p = bundleFile('function connect(){ this.udxRelayed = true; this.udxServerAddress = null; }');
    const res = checkBundleContainsMarkers({ bundlePath: p, requiredMarkers: ['udxRelayed', 'udxServerAddress'] });
    expect(res).toEqual({ ok: true, missing: [] });
  });

  it('the EI-18683847182779973 repro: a bundle built before the patch is missing the marker', () => {
    // A pre-patch hyperdht bundle: peerHandshake exists, but the relay
    // instrumentation the patch defines was never inlined.
    const p = bundleFile('function peerHandshake(c){ return c; }');
    const res = checkBundleContainsMarkers({ bundlePath: p, requiredMarkers: ['udxRelayed', 'udxServerAddress', 'udxClientAddress'] });
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['udxRelayed', 'udxServerAddress', 'udxClientAddress']);
  });

  it('reports only the markers that are actually absent (partial patch inline)', () => {
    const p = bundleFile('this.udxRelayed = true;');
    const res = checkBundleContainsMarkers({ bundlePath: p, requiredMarkers: ['udxRelayed', 'udxServerAddress'] });
    expect(res).toEqual({ ok: false, missing: ['udxServerAddress'] });
  });
});

describe('assertBundleContainsMarkers', () => {
  it('does not throw when every marker is present', () => {
    const p = bundleFile('this.udxRelayed = true;');
    expect(() => assertBundleContainsMarkers({ bundlePath: p, requiredMarkers: ['udxRelayed'] })).not.toThrow();
  });

  it('throws a specific, actionable error naming the missing marker(s) and the EI', () => {
    const p = bundleFile('function peerHandshake(){}');
    expect(() =>
      assertBundleContainsMarkers({ bundlePath: p, requiredMarkers: ['udxRelayed', 'udxServerAddress'] }),
    ).toThrowError(/udxRelayed, udxServerAddress.*EI-18683847182779973/s);
  });

  it('the fabricated-confirmation scenario: NEVER silently proceeds to let an absent field read undefined', () => {
    // Simulates the exact incident: the rig is about to trust `socket.udxRelayed`
    // across 101 connections from a bundle that predates the patch.
    const staleBundle = bundleFile('function peerHandshake(c){ return c; } /* pre-patch connect.js */');
    let launched = false;
    const launchRigIfSafe = () => {
      assertBundleContainsMarkers({ bundlePath: staleBundle, requiredMarkers: ['udxRelayed'] });
      launched = true; // must never be reached for a stale bundle
    };
    expect(launchRigIfSafe).toThrow();
    expect(launched).toBe(false);
  });
});
