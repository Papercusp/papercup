// Unit coverage for the one-shot-build dist-wipe guard's PURE decision
// (shouldRefuseOneShotBuild). The I/O legs (flock probe, lock-file/​/proc
// read) are thin wrappers exercised in integration; the decision matrix —
// which is where a regression would silently re-arm the 2026-06-29 blank-page
// footgun OR wrongly wedge the deploy pipeline — is pinned here.
import { describe, expect, it } from 'vitest';
import { shouldRefuseOneShotBuild } from './dist-wipe-guard';

const DIST = '/home/x/papercup/apps/operator-vite/dist';

describe('shouldRefuseOneShotBuild', () => {
  it('REFUSES when a live watcher serves the exact dist this build would empty', () => {
    expect(
      shouldRefuseOneShotBuild({ override: false, holderLive: true, served: DIST, outDir: DIST }),
    ).toBe(true);
  });

  it('proceeds when no watcher is live (a clean build is safe)', () => {
    expect(
      shouldRefuseOneShotBuild({ override: false, holderLive: false, served: DIST, outDir: DIST }),
    ).toBe(false);
  });

  it('proceeds when the live watcher serves a DIFFERENT dist (the deploy pipeline / another checkout)', () => {
    expect(
      shouldRefuseOneShotBuild({
        override: false,
        holderLive: true,
        served: '/home/x/papercup-release/apps/operator-vite/dist',
        outDir: DIST,
      }),
    ).toBe(false);
  });

  it('proceeds when the served dist is undeterminable (fail OPEN — never wedge the pipeline on uncertainty)', () => {
    expect(
      shouldRefuseOneShotBuild({ override: false, holderLive: true, served: null, outDir: DIST }),
    ).toBe(false);
  });

  it('proceeds when the operator opted into a clean wipe (VITE_ALLOW_LIVE_DIST_WIPE)', () => {
    expect(
      shouldRefuseOneShotBuild({ override: true, holderLive: true, served: DIST, outDir: DIST }),
    ).toBe(false);
  });

  it('matches dist paths regardless of trailing slash / non-normal form', () => {
    expect(
      shouldRefuseOneShotBuild({
        override: false,
        holderLive: true,
        served: `${DIST}/`,
        outDir: `/home/x/papercup/apps/operator-vite/./dist`,
      }),
    ).toBe(true);
  });
});
