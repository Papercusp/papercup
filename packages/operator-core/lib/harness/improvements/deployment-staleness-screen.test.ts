/**
 * deployment-staleness-screen tests (P-003 / EI-22450280531836927).
 *
 * The three verdicts are asserted separately on purpose: the failure this screen closes
 * was one condition read three different ways, and the cheapest way to reintroduce it is
 * to let an UNKNOWN verdict render as "current" — a check that cannot fail in the
 * unknown direction is exactly the false reassurance the three-valued type exists for.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  deploymentStalenessScreen,
  renderDeploymentStalenessDivert,
  resetDeploymentStalenessScreenCache,
  structuredToolFailureSubject,
  SCREEN_CACHE_TTL_MS,
} from './deployment-staleness-screen';

const REL = 'packages/operator-core/lib/agent-tools/improvements/capture.ts';
const ROOT = '/repo';
// blobAtCommit only accepts sha-shaped output, so a fixture blob must LOOK like one — a
// non-hex placeholder reads back as `git-unreadable`, i.e. an UNKNOWN that would make the
// stale/current assertions below pass or fail for a reason unrelated to what they assert.
const OLD_BLOB = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEW_BLOB = 'f0e1d2c3b4a596873625140fedcba98765432100';

function filingOf(toolName?: string, extra: Record<string, unknown> = {}) {
  return {
    payload: toolName
      ? { toolFailureProbation: { class: 'caller', report: { toolName, message: 'refused' }, ...extra } }
      : { observation: { ratings: [] } },
  };
}

/** A git reader that answers `rev-parse --verify <sha>:<path>` with a per-ref blob. */
function gitOf(blobs: Record<string, string | null>) {
  return vi.fn(async (args: string[]) => {
    const spec = args[args.length - 1] ?? '';
    const ref = spec.split(':')[0] ?? '';
    return blobs[ref] ?? null;
  });
}

function depsOf(blobs: Record<string, string | null>, over: Record<string, unknown> = {}) {
  return {
    sourceFileFor: (_name: string) => `${ROOT}/${REL}`,
    deployedSha: () => 'deadbee',
    repoRoot: ROOT,
    git: gitOf(blobs),
    cache: false,
    ...over,
  } as Parameters<typeof deploymentStalenessScreen>[1];
}

describe('structuredToolFailureSubject — a FIELD read, never prose', () => {
  it('reads payload.toolFailureProbation.report.toolName', () => {
    expect(structuredToolFailureSubject(filingOf('improvements:capture'))).toBe('improvements:capture');
  });

  it('is null for a filing that only MENTIONS a tool in prose', () => {
    // The title/body wording is deliberately not a subject: a wording-based subject
    // makes the screen's false positives unfalsifiable after the fact (plan Design).
    expect(
      structuredToolFailureSubject({
        payload: { note: 'improvements:capture rejected my toolFailure.directEvidence' },
      }),
    ).toBeNull();
    expect(structuredToolFailureSubject({})).toBeNull();
    expect(structuredToolFailureSubject(filingOf())).toBeNull();
  });

  it('rejects a blank or non-string tool name rather than screening on it', () => {
    expect(structuredToolFailureSubject(filingOf('   '))).toBeNull();
    expect(
      structuredToolFailureSubject({ payload: { toolFailureProbation: { report: { toolName: 42 } } } }),
    ).toBeNull();
  });
});

describe('deploymentStalenessScreen', () => {
  it('DIVERTS when the defining file differs between the serving build and the tree', async () => {
    const screen = await deploymentStalenessScreen(
      filingOf('improvements:capture'),
      depsOf({ deadbee: OLD_BLOB, staging: NEW_BLOB }),
    );
    expect(screen).toMatchObject({ screened: true, divert: true, state: 'stale', relPath: REL, treeRef: 'staging' });
  });

  it('does NOT divert when the blobs are identical', async () => {
    const screen = await deploymentStalenessScreen(
      filingOf('improvements:capture'),
      depsOf({ deadbee: OLD_BLOB, staging: OLD_BLOB }),
    );
    expect(screen).toMatchObject({ screened: true, divert: false, state: 'current' });
  });

  it('an unreadable git returns UNKNOWN — never "current", never a divert', async () => {
    const screen = await deploymentStalenessScreen(
      filingOf('improvements:capture'),
      depsOf({ deadbee: null, staging: NEW_BLOB }),
    );
    expect(screen).toMatchObject({ screened: true, divert: false, state: 'unknown', unknownReason: 'git-unreadable' });
  });

  it('an unregistered tool is UNKNOWN (tool-source-unknown), not a clean bill', async () => {
    const screen = await deploymentStalenessScreen(
      filingOf('nope:verb'),
      depsOf({ deadbee: OLD_BLOB, staging: NEW_BLOB }, { sourceFileFor: () => null }),
    );
    expect(screen).toMatchObject({ screened: true, state: 'unknown', unknownReason: 'tool-source-unknown' });
  });

  it('a filing with no structured toolFailure is not screened at all and touches no git', async () => {
    const deps = depsOf({ deadbee: OLD_BLOB, staging: NEW_BLOB });
    const screen = await deploymentStalenessScreen(filingOf(), deps);
    expect(screen).toEqual({ screened: false, divert: false, skipReason: 'no-structured-tool-failure' });
    expect(deps.git).not.toHaveBeenCalled();
  });

  it('a fault inside the screen never blocks triage', async () => {
    const screen = await deploymentStalenessScreen(
      filingOf('improvements:capture'),
      depsOf({}, {
        sourceFileFor: () => {
          throw new Error('registry exploded');
        },
      }),
    );
    expect(screen).toEqual({ screened: false, divert: false, skipReason: 'screen-unavailable' });
  });

  it('memoizes per tool+build so a 100-row retriage pass pays one git read per tool', async () => {
    resetDeploymentStalenessScreenCache();
    const deps = depsOf({ deadbee: OLD_BLOB, staging: NEW_BLOB }, { cache: true, now: () => 1_000 });
    const first = await deploymentStalenessScreen(filingOf('improvements:capture'), deps);
    const second = await deploymentStalenessScreen(filingOf('improvements:capture'), deps);
    expect(second).toEqual(first);
    // Two rev-parse reads for the FIRST call; the second is served from the memo.
    expect((deps.git as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('a deploy landing mid-pass invalidates the memo instead of serving a pre-deploy verdict', async () => {
    resetDeploymentStalenessScreenCache();
    const git = gitOf({ old: OLD_BLOB, new: NEW_BLOB, staging: NEW_BLOB });
    let sha = 'old';
    const deps = depsOf({}, { cache: true, now: () => 1_000, git, deployedSha: () => sha });
    expect(await deploymentStalenessScreen(filingOf('improvements:capture'), deps)).toMatchObject({ state: 'stale' });
    sha = 'new'; // the deploy landed
    expect(await deploymentStalenessScreen(filingOf('improvements:capture'), deps)).toMatchObject({ state: 'current' });
  });

  it('re-reads once the TTL has elapsed', async () => {
    resetDeploymentStalenessScreenCache();
    let nowMs = 1_000;
    const deps = depsOf({ deadbee: OLD_BLOB, staging: NEW_BLOB }, { cache: true, now: () => nowMs });
    await deploymentStalenessScreen(filingOf('improvements:capture'), deps);
    nowMs += SCREEN_CACHE_TTL_MS + 1;
    await deploymentStalenessScreen(filingOf('improvements:capture'), deps);
    expect((deps.git as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });
});

describe('renderDeploymentStalenessDivert', () => {
  it('names the deploy as the repair and the path to confirm it with', () => {
    const line = renderDeploymentStalenessDivert({
      screened: true,
      divert: true,
      state: 'stale',
      toolName: 'improvements:capture',
      relPath: REL,
      deployedSha: 'deadbee',
      treeRef: 'staging',
    });
    expect(line).toContain('LAND THE DEPLOY');
    expect(line).toContain(REL);
    expect(line).toContain('dev:pipeline_position');
    // Hedged, not asserted-closed: a differing blob proves the file moved, not that it
    // moved for THIS constraint. The reviewer confirms; the screen only makes them look.
    expect(line).toContain('may already be repaired');
  });
});
