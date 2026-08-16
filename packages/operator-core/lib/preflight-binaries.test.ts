/**
 * preflight-binaries.test.ts — the agent-CLI detection probes shared by
 * /api/desktop/preflight + /api/desktop/setup-status (they must agree).
 *
 * Contract: a probe is "on PATH first, then every SHARED candidate path from
 * agent-bin-detect, each required to answer `--version`", and every probe is
 * fail-soft (a missing binary → false, never a throw). execFile is mocked so
 * the test is deterministic + offline.
 *
 * ⚠ There is no `existsSync` gate any more (WI-39538). The candidate list
 * moved to `agentBinaryCandidates` and the `--version` probe is now the only
 * test applied to each entry — which is strictly stronger, because a
 * dangling symlink or a wrong-arch binary "exists" but cannot run. The old
 * exists-then-probe pair let this module and the settings page drift into
 * two different hand-kept lists, which is how an installed codex ended up
 * reported as missing by both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileImpl = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    execFileImpl(file, args, opts, cb),
}));

import { detectClaude, detectCodex, detectOmp } from './preflight-binaries';
import { agentBinaryCandidates } from './agent-bin-detect';

/** Only the given paths answer `--version` successfully; all others "fail". */
function probeSucceedsFor(...paths: string[]) {
  const set = new Set(paths);
  execFileImpl.mockImplementation((file: string, _a: unknown, _o: unknown, cb: (e: Error | null, r?: unknown) => void) => {
    if (set.has(file)) cb(null, { stdout: 'v1.2.3\n' });
    else cb(new Error('ENOENT'));
  });
}

beforeEach(() => execFileImpl.mockReset());

describe('detectClaude', () => {
  it('returns true when `claude` is on PATH (no candidate lookups needed)', async () => {
    probeSucceedsFor('claude');
    expect(await detectClaude()).toBe(true);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to a shared candidate path that probes ok', async () => {
    const candidate = agentBinaryCandidates('claude')[2];
    probeSucceedsFor(candidate); // not on PATH, but the candidate runs
    expect(await detectClaude()).toBe(true);
  });

  it('returns false when a candidate is present but its probe fails (fail-soft, no throw)', async () => {
    probeSucceedsFor(/* nothing succeeds */);
    await expect(detectClaude()).resolves.toBe(false);
  });

  it('returns false when nothing is on PATH and no candidate runs', async () => {
    probeSucceedsFor();
    expect(await detectClaude()).toBe(false);
  });
});

describe('detectOmp', () => {
  it('returns true when `omp` is on PATH', async () => {
    probeSucceedsFor('omp');
    expect(await detectOmp()).toBe(true);
  });

  it('returns false when omp is absent everywhere', async () => {
    probeSucceedsFor();
    expect(await detectOmp()).toBe(false);
  });
});

describe('detectCodex — the WI-39538 regression', () => {
  it('finds a codex installed beside the node running this process', async () => {
    // The reported box: codex was a sibling of the operator's own node, and
    // that dir was not on the systemd PATH. Both detectors missed it.
    probeSucceedsFor(agentBinaryCandidates('codex')[0]);
    expect(await detectCodex()).toBe(true);
  });

  it('searches the SAME candidate list the settings page resolves against', async () => {
    // The drift guard: if these two ever consult different lists again, one
    // surface can call a working codex missing while the other finds it.
    probeSucceedsFor();
    await detectCodex();
    const probed = execFileImpl.mock.calls.map((c) => c[0] as string);
    for (const candidate of agentBinaryCandidates('codex')) {
      expect(probed).toContain(candidate);
    }
  });
});
