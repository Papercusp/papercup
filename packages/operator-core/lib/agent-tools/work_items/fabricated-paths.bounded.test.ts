/**
 * EI-23439632326954844: `work_items:complete` hung >5min when `filesChanged` named
 * out-of-repo paths (a sibling checkout's file, `~/.config/...`). Root cause: this
 * detector ran `git log -1 --all -- <path>` — a FULL-HISTORY WALK when the path has no
 * history — for every declared path under every one of ~50 candidate roots, with only a
 * per-spawn timeout and no bound on the sum. The property under test is that the git work
 * is bounded ACROSS the detector, and that the two out-of-repo shapes never spawn at all.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';
import {
  FABRICATION_GIT_BUDGET_MS,
  MAX_FABRICATION_GIT_PROBES,
  fabricatedPathsInCompletion,
} from './fabricated-paths';

const ROOTS = Array.from({ length: 50 }, (_, i) => `/ws/checkout-${i}`);
const evidence = (filesChanged: string[]): CompletionVerificationEvidence =>
  ({ filesChanged }) as CompletionVerificationEvidence;

describe('fabricatedPathsInCompletion — bounded git fan-out (EI-23439632326954844)', () => {
  it('caps total git spawns across paths × roots, and a capped path is silence not a finding', () => {
    let spawns = 0;
    const out = fabricatedPathsInCompletion(
      evidence(['email/apps/sidecar/src/a.ts', 'calendar/apps/sidecar/src/b.ts', 'other/c.ts']),
      {
        repoRoots: ROOTS,
        exists: () => false,
        gitKnows: () => {
          spawns += 1;
          return false; // every root says "never existed" — 150 spawns without the cap
        },
      },
    );
    expect(spawns).toBe(MAX_FABRICATION_GIT_PROBES);
    expect(spawns).toBeLessThan(3 * ROOTS.length);
    // The first path was judged (and accused) within budget; the rest were not judged.
    expect(out).toEqual({ neverExisted: ['email/apps/sidecar/src/a.ts'] });
  });

  it('stops spawning once the wall-clock budget is spent (injected clock)', () => {
    let spawns = 0;
    let clock = 0;
    const out = fabricatedPathsInCompletion(evidence(['x/one.ts', 'x/two.ts']), {
      repoRoots: ROOTS,
      exists: () => false,
      now: () => clock,
      gitKnows: () => {
        spawns += 1;
        clock += FABRICATION_GIT_BUDGET_MS; // one probe eats the whole budget
        return false;
      },
    });
    expect(spawns).toBe(1);
    expect(out).toEqual({ neverExisted: ['x/one.ts'] });
  });

  it('a home-relative `~/...` path is another tree: never resolved under a root, never spawned', () => {
    let spawns = 0;
    const seen: string[] = [];
    const out = fabricatedPathsInCompletion(
      evidence(['~/.config/systemd/user/papercusp-email-sidecar.service.d/watch.conf', '~']),
      {
        repoRoots: ROOTS,
        exists: (abs) => {
          seen.push(abs);
          return false;
        },
        gitKnows: () => {
          spawns += 1;
          return false;
        },
      },
    );
    expect(out).toBeUndefined();
    expect(spawns).toBe(0);
    expect(seen).toEqual([]);
  });

  it('the cross-repo form `<repoName>/<path>` is cleared by existence under that root with zero spawns', () => {
    let spawns = 0;
    const out = fabricatedPathsInCompletion(evidence(['email/apps/sidecar/src/build-identity.ts']), {
      repoRoots: ['/ws/papercusp', '/ws/email'],
      exists: (abs) => abs === '/ws/email/apps/sidecar/src/build-identity.ts',
      gitKnows: () => {
        spawns += 1;
        return false;
      },
    });
    expect(out).toBeUndefined();
    // The papercusp root cannot clear it and costs one probe; the email root clears it for free.
    expect(spawns).toBe(1);
  });

  it('defaults are finite and small enough to stay under the MCP transport deadline', () => {
    expect(FABRICATION_GIT_BUDGET_MS).toBeLessThanOrEqual(5_000);
    expect(MAX_FABRICATION_GIT_PROBES).toBeLessThanOrEqual(12);
  });
});
