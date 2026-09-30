/**
 * The event Cupboard round trip (portable-identity-packages-2026-09-26 P-011,
 * D-023 §6 / D-026 — the identities-v1 D-068 §4 gap: nothing exercised the `event`
 * kind end to end).
 *
 * One registry row travels the whole distribution path with real code at every hop:
 * publishEventToCupboard exports it through the real package writer, the install core
 * clones that exported directory, the IO seam's projection turns the installed package
 * back into a registry write, and the blueprint resolver pins it as an identity package.
 * Only the GitHub lookup and the listing POST are seams, and export-only never reaches them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetPapercuspRootForTests } from '../papercusp-root';
import { publishEventToCupboard } from './publish-event-core';
import { installEventFromCupboardCore } from './install-event-core';
import { registryInputFromPackage } from './install-event-io';
import { installedEventRef, writeEventPackageDir, type EventExportSource } from './event-store';
import { resolveLocalBlueprintPackage } from '../blueprint/compile-packages';

const GITHUB_URL = 'https://github.com/acme/cupboard-events';

const SOURCE_ROW: EventExportSource = {
  eventKey: 'deploy:done:release',
  title: 'Deploy done',
  description: 'A release deploy finished and its health check passed.',
  keyPattern: 'deploy:done:*',
  tags: ['release', 'deploy'],
};

/** Unpinned install: only the tip-clone path may run (the pinned path has its own
 *  suite in install-self-describing-core.test.ts). */
function unpinnedDeps(repo: string, tmp: string) {
  return {
    cloneRepo: async (_url: string, dest: string) => { await fs.cp(repo, dest, { recursive: true }); },
    fetchAtSha: async (): Promise<void> => { throw new Error('unpinned roundtrip: fetchAtSha must not be called'); },
    listTreeBlobs: async (): Promise<never> => { throw new Error('unpinned roundtrip: listTreeBlobs must not be called'); },
    tmpDir: () => tmp,
  };
}

let root: string;
let previousPapercuspHome: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'cupboard-event-roundtrip-'));
  previousPapercuspHome = process.env.PAPERCUSP_HOME;
  process.env.PAPERCUSP_HOME = root;
  _resetPapercuspRootForTests();
});

afterEach(async () => {
  if (previousPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
  else process.env.PAPERCUSP_HOME = previousPapercuspHome;
  _resetPapercuspRootForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('event Cupboard round trip', () => {
  it('a registry row survives export -> install -> registry projection -> blueprint pin', async () => {
    const repo = join(root, 'event-repo');
    const fetchRepo = vi.fn();
    const publish = vi.fn();

    const published = await publishEventToCupboard(
      { eventKey: SOURCE_ROW.eventKey, github_url: GITHUB_URL, version: '1.2.0', exportOnly: true },
      {
        listEventKeys: async () => [SOURCE_ROW],
        writePackage: (event, opts) => writeEventPackageDir(event, { ...opts, targetDir: repo }),
        fetchRepo,
        publish,
      },
    );
    expect(published).toMatchObject({ ok: true, exportedOnly: true });
    if (!published.ok) return;
    // The colon-delimited key is sanitized into the package ref the listing is filed under.
    expect(published.export.ref).toBe('deploy-done-release');
    expect(fetchRepo).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    const targetRef = installedEventRef(GITHUB_URL, published.export.ref);
    const installed = await installEventFromCupboardCore(
      { githubUrl: GITHUB_URL, listingRef: published.export.ref, targetRef },
      unpinnedDeps(repo, root),
    );
    expect(installed).toMatchObject({
      ok: true, ref: targetRef, eventKey: SOURCE_ROW.eventKey, version: '1.2.0',
      installedTo: join(root, 'events', 'installed', targetRef), pin: null,
    });

    // The curated half comes back exactly; the contributor is what the INSTALL observed,
    // never a publisher claim — which is the identity the D-026 claim compares.
    expect(registryInputFromPackage(installed, 'ws-roundtrip')).toEqual({
      workspaceId: 'ws-roundtrip',
      eventKey: SOURCE_ROW.eventKey,
      title: SOURCE_ROW.title,
      description: SOURCE_ROW.description,
      keyPattern: SOURCE_ROW.keyPattern,
      tags: SOURCE_ROW.tags,
      contributor: `cupboard:${targetRef}`,
    });

    // The installed event is now bundleable: an identity that pins it resolves the same
    // package, at the published revision.
    const pin = await resolveLocalBlueprintPackage({ kind: 'event', ref: targetRef });
    expect(pin).toMatchObject({
      packageKind: 'event',
      ref: targetRef,
      revision: '1.2.0',
      value: expect.objectContaining({ eventKey: SOURCE_ROW.eventKey, keyPattern: SOURCE_ROW.keyPattern }),
    });
  });

  it('two listings shipping the same key install as distinct packages with distinct contributors', async () => {
    const results = [];
    for (const githubUrl of [GITHUB_URL, 'https://github.com/rival/cupboard-events']) {
      const repo = join(root, `repo-${results.length}`);
      writeEventPackageDir(SOURCE_ROW, { ref: 'deploy-done-release', version: '1.0.0', source: githubUrl, targetDir: repo });
      const targetRef = installedEventRef(githubUrl, 'deploy-done-release');
      const installed = await installEventFromCupboardCore(
        { githubUrl, listingRef: 'deploy-done-release', targetRef }, unpinnedDeps(repo, root));
      results.push(registryInputFromPackage(installed, 'ws-roundtrip'));
    }
    // Same key, different claimants: the registry claim is what keeps the second from
    // taking the first's row (event-key-registry.integration.test.ts).
    expect(results[0]?.eventKey).toBe(results[1]?.eventKey);
    expect(results[0]?.contributor).not.toBe(results[1]?.contributor);
  });
});
