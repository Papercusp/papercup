/**
 * Unit tests for `runBootstrapLeg` (P-205/WI-3591 — the G-8 cold-clone bootstrap
 * leg wired into `system:git-sync`'s handleGitSync as `git-sync:bootstrap`).
 * Mocks the leg's direct dependencies only (harness-registry, hive-membership-store,
 * usage-actor, hive-git storage/bootstrap, db-org) — everything else `git-sync-action.ts`
 * imports at module scope is left real since this leg never calls into it.
 *
 * Asserts: (1) the SELF-GATE — no-op when the local repo already has any namespace,
 * or when no hive member has an attested device pubkey; (2) the happy-path call
 * shape into `bootstrapFromPeer` (repo path, a Duplex, selfDevicePubkey) and the
 * routine-metadata patch recorded under the `bootstrap` key; (3) never-throws when
 * `bootstrapFromPeer` itself rejects (fail-soft, matches every sibling leg's contract).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeDuplex = { on: (ev: string, cb: () => void) => void };
type BootstrapOutcome = {
  ok: boolean;
  namespaces: string[];
  skippedExisting: string[];
  skippedSelf: string | null;
  stderr: string;
};
type RegistryProject = {
  slug: string;
  hive_slug?: string;
  self_repo?: boolean;
  github_repository_id?: number;
  github_remote?: string;
};

const {
  loadHarnessRegistryMock,
  listHiveMembersMock,
  hiveGitRepoPathMock,
  listNamespacesMock,
  ensurePotGitRepoMock,
  bootstrapFromPeerMock,
  resolveUsageActorMock,
  unsafeMock,
  getBootedHarnessMock,
  bootSingleHarnessMock,
  openHiveGitDuplexToDeviceMock,
  loadCachedLocalAnnounceIdentityMock,
} = vi.hoisted(() => ({
  loadHarnessRegistryMock: vi.fn<() => Promise<{ projects: RegistryProject[] }>>(async () => ({
    projects: [{ slug: 'shop-hive', hive_slug: 'shop-hive', self_repo: true }],
  })),
  listHiveMembersMock: vi.fn(async (_ws: string, _hive: string) => [
    { deviceAttestations: [{ device_pubkey: 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=' }] },
  ]),
  hiveGitRepoPathMock: vi.fn((potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  listNamespacesMock: vi.fn(async (_repoPath: string) => [] as string[]),
  // G-8 cold-start (WI-3496 rig finding): the leg must ensure the bare store
  // exists BEFORE any read against it — mirrors the real helper's return.
  ensurePotGitRepoMock: vi.fn(async (potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  // DIAL-REGISTRY (WI-3583/P-302): getBootedHarness is dynamically imported
  // (see git-sync-action.ts's own comment on why) so it must be mocked here
  // too, or the dynamic import pulls in boot-all.ts's real module graph —
  // which reaches back into '../../harness-registry' for exports this file's
  // OWN partial mock of that module doesn't define (deregisterEphemeralForeignHarness
  // et al), crashing with a confusing "no export is defined on the mock" error
  // that looks unrelated to this leg. Defaults to "no live swarm join yet" —
  // the same fail-soft floor the real code falls back to — so the existing
  // happy-path assertions below (any Duplex, selfDevicePubkey passed through)
  // stay valid without a real swarm.
  getBootedHarnessMock: vi.fn((_ws: string, _hive: string) => null as { swarm?: { topicHex?: string } } | null),
  // WI-5247: resolveHiveGitTopicHex demand-boots when getBootedHarness misses
  // (a harness never booted this process, not just an evicted one) — mocked
  // as a resolved no-op so the existing fail-soft-stub assertions stay valid.
  bootSingleHarnessMock: vi.fn(async (_ws: string, _hive: string) => ({ state: 'booted' as const })),
  openHiveGitDuplexToDeviceMock: vi.fn(async (_topic: Buffer, _device: string, _req: unknown) => {
    const d = { on: (_ev: string, _cb: () => void) => {} };
    return d;
  }),
  // Mirrors the REAL bootstrapFromPeer → fetchOverDuplex contract: it always
  // attaches an 'error' listener to the duplex before ever awaiting anything
  // (fetch-transport.ts's own fix for the DIAL-REGISTRY GAP idiom's
  // pre-destroyed stub duplex) — a mock that ignored the duplex entirely
  // would falsely "pass" while masking an unhandled-error crash the real
  // call chain no longer has.
  bootstrapFromPeerMock: vi.fn<
    (repoPath: string, duplex: FakeDuplex, opts: Record<string, unknown>) => Promise<BootstrapOutcome>
  >(async (_repoPath, duplex, _opts) => {
    // Mimic the REAL bootstrapFromPeer's timing: it awaits dropQuarantine/
    // listNamespaces BEFORE fetchOverDuplex ever attaches an 'error' listener
    // — so a stub destroyed WITHOUT its own no-op listener emits an UNHANDLED
    // 'error' in this gap (live-caught: crash-looped the tower bg-host,
    // WI-3496). Deferring one macrotask here makes the stub-path tests below
    // genuine regression tests for that; attaching synchronously would mask it.
    await new Promise((r) => setImmediate(r));
    duplex.on('error', () => {});
    return {
      ok: true,
      namespaces: ['abcd1234'],
      skippedExisting: [],
      skippedSelf: null,
      stderr: '',
    };
  }),
  resolveUsageActorMock: vi.fn(
    async (): Promise<{ githubUserId: number; devicePubkey: string } | null> => ({
      githubUserId: 1,
      devicePubkey: 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=',
    }),
  ),
  // gh-INDEPENDENT self-identity: resolveUsageActor returns null whenever `gh`
  // is unauthenticated / rate-limited, so the leg falls back to the persisted,
  // keychain-verified announce-identity cache (no network). Default null — the
  // happy path uses the actor's devicePubkey and never reaches this `??` arm.
  loadCachedLocalAnnounceIdentityMock: vi.fn(async () => null as { devicePubkeyBase64?: string } | null),
  unsafeMock: vi.fn(async (_text: string, _params: unknown[]) => []),
}));

vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: loadHarnessRegistryMock }));
vi.mock('../../hive-membership-store', () => ({ listHiveMembers: listHiveMembersMock }));
/* Storage is fully stubbed (no real git/fs from a unit test), but the stub set is
 * derived from the REAL export list so a new export in storage.ts cannot silently
 * break this file. An ABSENT export throws inside runBootstrapLeg, whose catch
 * swallows it into a console.warn — vitest-fail-on-console then reds this file with
 * a cascade of misleading "called 0 times" assertions (the leg aborted before
 * dialing), and the green gate with it. That is EI-18748959711888135: adding
 * `sweepStalePackTmpFiles` to storage.ts red-pinned the fleet gate.
 * Every export the test does not care about becomes an inert vi.fn(); non-function
 * exports (timeouts, thresholds) keep their real values; the explicit stubs below
 * override the generated ones. */
vi.mock('../../sync/pot-git/storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Inert stubs resolve a promise rather than returning undefined: storage's exports
  // are overwhelmingly `async`, and callers fire-and-forget them
  // (`sweepStalePackTmpFiles(...).catch(...)`), which throws on a bare vi.fn().
  // A test that needs a SYNC return value stubs that export explicitly, below.
  const inert = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(async () => undefined) : v,
    ]),
  );
  return {
    ...inert,
    hiveGitRepoPath: hiveGitRepoPathMock,
    listNamespaces: listNamespacesMock,
    ensurePotGitRepo: ensurePotGitRepoMock,
    // Deterministic base64→hex, mirroring the real mapping's shape without the
    // raw-32 length check (the fixture pubkeys are readable strings, not real keys).
    deviceNamespaceKey: (b64: string) => Buffer.from(b64, 'base64').toString('hex'),
  };
});
vi.mock('../../sync/pot-git/bootstrap', () => ({ bootstrapFromPeer: bootstrapFromPeerMock }));
vi.mock('../usage-actor', () => ({ resolveUsageActor: resolveUsageActorMock }));
vi.mock('../../sync/hyperbee/boot-all', () => ({
  getBootedHarness: getBootedHarnessMock,
  bootSingleHarness: bootSingleHarnessMock,
}));
vi.mock('../../sync/pot-git/peer-dial-registry', () => ({ openHiveGitDuplexToDevice: openHiveGitDuplexToDeviceMock }));
vi.mock('../../sync/hyperbee/local-announce-identity', () => ({ loadCachedLocalAnnounceIdentity: loadCachedLocalAnnounceIdentityMock }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: { unsafe: unsafeMock } }) };
});

// Import AFTER the mocks so the module resolves the mocked deps.
import { __resetBootstrapDialBackoffForTest, runBootstrapLeg } from './git-sync-action';

const SLUG = 'shop-hive';
const WS = 'ws-1';

/** Every override below must keep consuming the duplex (attach a no-op
 *  'error' listener) exactly like the real fetchOverDuplex chain does now —
 *  see the vi.hoisted() comment above for why. */
const bootstrapOutcome = (result: BootstrapOutcome) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  await new Promise((r) => setImmediate(r)); // real-timing gap — see vi.hoisted comment
  duplex.on('error', () => {});
  return result;
};
const bootstrapRejection = (err: Error) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  await new Promise((r) => setImmediate(r)); // real-timing gap — see vi.hoisted comment
  duplex.on('error', () => {});
  throw err;
};

const SELF_DEVICE = 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=';
const PEER_DEVICE = 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=';
// Distinct-prefixed peers for the multi-candidate iteration / cap tests below
// (the leg logs device.slice(0,8) into the dialLog, so the prefixes differ).
const PEER_DEVICE_2 = 'ZGV2LXR3by1wdWJrZXktYmFzZTY0LTMyYnl0ZXMtISEhIQ==';
const PEER_DEVICE_3 = 'dGhyZWUtZGV2LXB1YmtleS1iYXNlNjQtMzJieXRlcy0hIQ==';
const PEER_DEVICE_4 = 'Zm91ci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzIQ==';

/** A fake dial-registry duplex: `destroyed:true` models a registry miss (the
 *  pre-destroyed decoy — "no live dial path"); `destroyed:false` a live socket
 *  the leg then hands to bootstrapFromPeer. */
const dialDuplex = (destroyed: boolean) => ({ on: (_ev: string, _cb: () => void) => {}, destroyed });

beforeEach(() => {
  loadHarnessRegistryMock.mockClear();
  listHiveMembersMock.mockClear();
  hiveGitRepoPathMock.mockClear();
  listNamespacesMock.mockClear();
  bootstrapFromPeerMock.mockClear();
  resolveUsageActorMock.mockClear();
  unsafeMock.mockClear();
  getBootedHarnessMock.mockClear();
  bootSingleHarnessMock.mockClear();
  openHiveGitDuplexToDeviceMock.mockClear();
  loadCachedLocalAnnounceIdentityMock.mockClear();
  loadCachedLocalAnnounceIdentityMock.mockResolvedValue(null); // default: cache empty (actor path is used)
  resolveUsageActorMock.mockResolvedValue({ githubUserId: 1, devicePubkey: SELF_DEVICE });
  loadHarnessRegistryMock.mockResolvedValue({
    projects: [{ slug: SLUG, hive_slug: SLUG, self_repo: true }],
  });
  listHiveMembersMock.mockResolvedValue([
    { deviceAttestations: [{ device_pubkey: PEER_DEVICE }] },
  ]);
  listNamespacesMock.mockResolvedValue([]);
  bootstrapFromPeerMock.mockImplementation(bootstrapOutcome({
    ok: true,
    namespaces: ['abcd1234'],
    skippedExisting: [],
    skippedSelf: null,
    stderr: '',
  }));
  getBootedHarnessMock.mockReturnValue(null); // default: no live swarm join — the fail-soft floor
  openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({ on: (_ev: string, _cb: () => void) => {} }));
  // EI-15333: the backoff map is module-scope state shared across every test
  // in this file — clear it each test or an earlier no-such-repo test would
  // silently starve a later test's dial of the same (slug, peer) pair.
  __resetBootstrapDialBackoffForTest();
});

describe('runBootstrapLeg', () => {
  /* Recurrence guard for EI-18748959711888135 — asserts the CLASS, not the instance.
   * `sweepStalePackTmpFiles` was added to storage.ts while this file's mock was a
   * literal object; the absent export threw inside runBootstrapLeg's catch, surfaced
   * only as a console.warn, and vitest-fail-on-console turned it into 28 failures
   * here (mostly misleading "called 0 times" — the leg aborted before dialing) plus
   * a red fleet gate. The factory is now derived from the real export list; this
   * fails if anyone reverts it to a hand-listed object and misses an export. */
  it('EI-18748959711888135: the storage stub exposes every real storage export', async () => {
    const real = await vi.importActual<Record<string, unknown>>('../../sync/pot-git/storage');
    const stub = (await import('../../sync/pot-git/storage')) as unknown as Record<string, unknown>;
    const missingFrom = (m: Record<string, unknown>) => Object.keys(real).filter((k) => !(k in m));
    expect(missingFrom(stub)).toEqual([]);
    // Exercise the detection itself against a deliberately incomplete stub, so this
    // guard cannot silently stop detecting (a guard whose failure path never runs is
    // indistinguishable from no guard).
    const probeKey = Object.keys(real)[0]!;
    const incomplete = { ...stub };
    delete incomplete[probeKey];
    expect(missingFrom(incomplete)).toEqual([probeKey]);
  });

  it('self-gates as a no-op when the local repo already has a peer MEMBER namespace (warm repo)', async () => {
    // Warm = the namespace of an attested member device other than self —
    // the mocked deviceNamespaceKey is base64→hex, so PEER_DEVICE's hex it is.
    const peerHex = Buffer.from(PEER_DEVICE, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peerHex]);
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG);
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('WI-3496 part 2: a non-member namespace (github-ingress, same-tick earlier leg) does NOT count as warm — still bootstraps', async () => {
    // runGithubBridgeLeg runs BEFORE this leg in the same tick and writes a
    // locally-synthesized ingress namespace on the very first tick of a
    // GitHub-bridged repo — counting it as warm made every bridged pot skip
    // G-8 cold-join forever (live-caught on the P-302 rig).
    listNamespacesMock.mockResolvedValue(['1n6re551n6re55deadbeef00']);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('G-8 cold start (WI-3496): ensures the bare store exists BEFORE reading namespaces', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG);
    const ensureOrder = ensurePotGitRepoMock.mock.invocationCallOrder[0];
    const listOrder = listNamespacesMock.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(listOrder);
  });

  it('WI-3496: our OWN namespace does not count as warm — still bootstraps from the peer', async () => {
    // own-head-publish created only the self namespace (its key = the mocked
    // base64→hex of the self device pubkey); a cold-join from a peer must
    // still run or the store never gains any peer namespace.
    const selfHex = Buffer.from('c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=', 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([selfHex]);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('self-gates as a no-op when no hive member has an attested device pubkey', async () => {
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [] }]);
    await runBootstrapLeg(SLUG, WS);
    expect(listHiveMembersMock).toHaveBeenCalledWith(WS, SLUG);
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('calls bootstrapFromPeer with the resolved repo path, a Duplex, and selfDevicePubkey on the happy path', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    const [repoPath, duplex, opts] = bootstrapFromPeerMock.mock.calls[0];
    expect(repoPath).toBe(`/repos/${SLUG}/${SLUG}`);
    expect(duplex).toBeTruthy();
    expect((opts as Record<string, unknown>).selfDevicePubkey).toBe('c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=');
  });

  it('patches routine metadata under the bootstrap key with the outcome summary', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(unsafeMock).toHaveBeenCalledTimes(1);
    const [text, params] = unsafeMock.mock.calls[0];
    expect(text).toContain('harness_shared.routines');
    expect(params[0]).toBe(SLUG);
    const patch = JSON.parse(params[1] as string);
    expect(patch.bootstrap).toMatchObject({ ok: true, namespaceCount: 1, skippedExisting: 0 });
  });

  it('falls back to ctx-derived potHomeSlug from entry.slug when hive_slug is absent but self_repo is true', async () => {
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: SLUG, self_repo: true }],
    });
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG);
  });

  it('no-ops (no throw) when the registry has no matching entry for slug', async () => {
    loadHarnessRegistryMock.mockResolvedValue({ projects: [] });
    await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('never throws when bootstrapFromPeer rejects (fail-soft)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bootstrapFromPeerMock.mockImplementation(bootstrapRejection(new Error('boom')));
      await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick failed'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('self-gates as a no-op when the only attested member device IS this device (no peer to bootstrap from)', async () => {
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: SELF_DEVICE }] }]);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
  });

  it('P-302: dials the peer device over the real duplex when a live swarm topic exists (WI-3583 wiring)', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    const [topic, device, req] = openHiveGitDuplexToDeviceMock.mock.calls[0];
    expect(Buffer.isBuffer(topic) && (topic as Buffer).toString('hex')).toBe('deadbeef');
    expect(device).toBe(PEER_DEVICE); // dials a peer, never self (WI-1559 squat guard stays in bootstrapFromPeer)
    expect((req as { repoKey: string }).repoKey).toBe(SLUG);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  // ── WI-5168: federated repoKey (repo-identity.ts's canonicalRepoKey) ──────
  // A device's LOCAL install `slug` for the same upstream repo can differ from
  // a peer's (join-pot derives it from that device's own registry — e.g. a
  // tower registers 'hello-world-3', a joining VM registers 'hello-world' for
  // the SAME octocat/Hello-World), so keying the bare-store path AND the wire
  // repoKey on `slug` meant a G-8 fetch asked the peer for a repoKey the peer
  // never created its store under — NEVER rendezvousing for two devices whose
  // install slugs differ. These assert the store path + wire repoKey both key
  // on the FEDERATED identity (github_repository_id) instead, whenever it's
  // known — independent of what this device happens to call the repo locally.
  it('WI-5168: keys the bare store + wire repoKey on github_repository_id, NOT the local slug, when known', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world-3', hive_slug: 'hello-world-3', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world-3', WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith('hello-world-3', 'gh-1296269');
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    const [, , req] = openHiveGitDuplexToDeviceMock.mock.calls[0];
    expect((req as { repoKey: string }).repoKey).toBe('gh-1296269');
  });

  it('WI-5168: two devices with DIFFERENT local slugs for the SAME github_repository_id resolve to the IDENTICAL repoKey', async () => {
    // Simulates the exact live-caught defect: tower + VM registered the same
    // upstream under different install slugs. Both must derive the same
    // wire+store repoKey for G-8 to ever rendezvous.
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world-3', hive_slug: 'hello-world-3', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world-3', WS);
    const towerRepoKey = (openHiveGitDuplexToDeviceMock.mock.calls[0][2] as { repoKey: string }).repoKey;
    openHiveGitDuplexToDeviceMock.mockClear();
    ensurePotGitRepoMock.mockClear();
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world', hive_slug: 'hello-world', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world', WS);
    const vmRepoKey = (openHiveGitDuplexToDeviceMock.mock.calls[0][2] as { repoKey: string }).repoKey;
    expect(towerRepoKey).toBe(vmRepoKey);
    expect(towerRepoKey).toBe('gh-1296269');
  });

  it('WI-5168: falls back to owner/repo from github_remote when github_repository_id is not yet known', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{
        slug: SLUG,
        hive_slug: SLUG,
        self_repo: true,
        github_remote: 'https://github.com/octocat/Hello-World.git',
      }],
    });
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, 'gh-octocat--hello-world');
  });

  it('WI-5168: falls back to the local slug when neither github_repository_id nor github_remote is known (pre-existing, non-regressed limitation)', async () => {
    await runBootstrapLeg(SLUG, WS); // default fixture: no github coords at all
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG);
  });

  it('falls back to the pre-WI-3583 destroyed stub (never dials) when no live swarm topic exists', async () => {
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('WI-5247: demand-boots the substrate when getBootedHarness misses (never-booted-this-process, not just evicted)', async () => {
    // Before the fix, a harness that was simply never booted this process
    // (as opposed to evicted-then-reboot-on-access) got a permanent null
    // from getBootedHarness with NOTHING registering demand for it — this
    // tick is exactly that demand signal and must fire a background boot.
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(bootSingleHarnessMock).toHaveBeenCalledWith(WS, SLUG);
  });

  it('WI-5247: does NOT demand-boot when getBootedHarness already returns a live handle', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    await runBootstrapLeg(SLUG, WS);
    expect(bootSingleHarnessMock).not.toHaveBeenCalled();
  });

  it('never throws and skips the DB patch when bootstrapFromPeer reports ok:false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bootstrapFromPeerMock.mockImplementation(bootstrapOutcome({
        ok: false,
        namespaces: [],
        skippedExisting: [],
        skippedSelf: null,
        stderr: 'fetch-failed: no live connection',
      }));
      await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(unsafeMock).toHaveBeenCalledTimes(1); // metadata is still patched with ok:false
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick reported errors'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Multi-candidate iteration + gh-free self-fallback (P-303 reverse-leg fix) ──
  // Before this fix a single `.find()` pick wedged G-8 permanently whenever its
  // one chosen candidate was offline/stale (a live registered peer sat unused),
  // and self-identification rode on `gh` reachability — an undefined self let
  // `find(d => d !== undefined)` pick THIS device's own attestation, so every
  // tick decoyed itself. Live-caught on the P-303 reverse-leg drill 2026-07-17.

  it('iterates to the next candidate when the first has no live dial path (destroyed decoy duplex)', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    // First device: registry miss (pre-destroyed decoy); second: a live socket.
    openHiveGitDuplexToDeviceMock.mockImplementation(async (_t: Buffer, device: string) =>
      dialDuplex(device === PEER_DEVICE),
    );
    await runBootstrapLeg(SLUG, WS);
    // Dialed both, in order; only the live (second) one reached bootstrapFromPeer.
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(2);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[0][1]).toBe(PEER_DEVICE);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[1][1]).toBe(PEER_DEVICE_2);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    const patch = JSON.parse((unsafeMock.mock.calls[0][1] as unknown[])[1] as string);
    expect(patch.bootstrap.ok).toBe(true);
  });

  it('iterates past a LIVE candidate whose fetch fails (ok:false) to a later one that succeeds', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // both live
    bootstrapFromPeerMock
      .mockImplementationOnce(bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: half-dead channel' }))
      .mockImplementationOnce(bootstrapOutcome({ ok: true, namespaces: ['abcd1234'], skippedExisting: [], skippedSelf: null, stderr: '' }));
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2); // first failed → tried the second
    const patch = JSON.parse((unsafeMock.mock.calls[0][1] as unknown[])[1] as string);
    expect(patch.bootstrap.ok).toBe(true); // the final (successful) outcome wins
  });

  it('surfaces the peer refuse reason in the dialLog when a LIVE dial fails (duplex.errored)', async () => {
    // The dialing box already RECEIVES the peer's refuse over the wire
    // (serve-wiring handleRefuse destroys the client duplex with
    // `pot-git serve refused: <reason>`), retained on `duplex.errored`. The
    // tick log must show it so the reverse-leg cause is diagnosable HERE — not
    // only via a cross-machine serve.log read (P-303 drill 2026-07-17).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      // A live socket that carries a retained destroy-error, exactly as a
      // refused FrameDuplex does (`.errored` set synchronously by .destroy(err)).
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: no-such-repo'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'duplex already destroyed before fetch began (no live dial path)' }),
      );
      await runBootstrapLeg(SLUG, WS);
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick reported errors'));
      expect(warnMsg).toBeTruthy();
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:failed(pot-git serve refused: no-such-repo)`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('caps live fetch attempts at MAX_LIVE_ATTEMPTS (3) even with more failing candidates', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([
        { deviceAttestations: [PEER_DEVICE, PEER_DEVICE_2, PEER_DEVICE_3, PEER_DEVICE_4].map((d) => ({ device_pubkey: d })) },
      ]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // all live
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: no upload-pack' }),
      );
      await runBootstrapLeg(SLUG, WS);
      // 4 live+failing candidates → only 3 attempts (the 4th short-circuits at
      // the loop top), and no 4th dial is even opened.
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(3);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick reported errors'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns "no live dial path" listing EVERY candidate when all are registry misses (dialLog signature)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([
        { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
      ]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(true)); // all no-path
      await runBootstrapLeg(SLUG, WS);
      expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('no live dial path'));
      expect(warnMsg).toBeTruthy();
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:no-path`);
      expect(warnMsg).toContain(`${PEER_DEVICE_2.slice(0, 8)}:no-path`);
      const patch = JSON.parse((unsafeMock.mock.calls[0][1] as unknown[])[1] as string);
      expect(patch.bootstrap.ok).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('gh-free self-fallback: resolveUsageActor null → self identity from the announce-identity cache; self is excluded from candidates', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    resolveUsageActorMock.mockResolvedValue(null); // gh unauthenticated / rate-limited
    loadCachedLocalAnnounceIdentityMock.mockResolvedValue({ devicePubkeyBase64: SELF_DEVICE });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: SELF_DEVICE }, { device_pubkey: PEER_DEVICE }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await runBootstrapLeg(SLUG, WS);
    expect(loadCachedLocalAnnounceIdentityMock).toHaveBeenCalled(); // the `??` fallback arm was taken
    // self filtered out → only the peer is dialed, carrying the cache-derived
    // selfDevicePubkey (not undefined, which used to let find() pick self).
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[0][1]).toBe(PEER_DEVICE);
    expect((bootstrapFromPeerMock.mock.calls[0][2] as Record<string, unknown>).selfDevicePubkey).toBe(SELF_DEVICE);
  });

  it('gh-free self-fallback: actor null AND cache miss → selfDevicePubkey undefined, still bootstraps (no crash)', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    resolveUsageActorMock.mockResolvedValue(null);
    loadCachedLocalAnnounceIdentityMock.mockResolvedValue(null); // nothing cached either
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    expect((bootstrapFromPeerMock.mock.calls[0][2] as Record<string, unknown>).selfDevicePubkey).toBeUndefined();
  });

  // ── EI-15333: no-such-repo dial backoff ──
  // A peer that definitively refuses a bootstrap dial with `no-such-repo`
  // (it genuinely has no store for this repo) used to be re-dialed every
  // single tick forever — a wasted live handshake plus an identical
  // permanent error line. It should back off instead: not be live-dialed
  // again for a bounded window, without disturbing dialing of OTHER
  // candidates or of a DIFFERENT repo/slug.

  it('EI-15333: does not re-dial a peer within the backoff window after a no-such-repo refusal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: no-such-repo'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'no-such-repo' }),
      );

      // First tick: a real live dial happens and refuses no-such-repo.
      await runBootstrapLeg(SLUG, WS);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);

      // Second tick (same process, backoff window still open): the peer is
      // skipped WITHOUT a live dial — the leg falls straight to the "no live
      // dial path" branch since it's the only candidate.
      warnSpy.mockClear();
      await runBootstrapLeg(SLUG, WS);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1); // unchanged — no new dial
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1); // unchanged
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('no live dial path'));
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:backoff(no-such-repo)`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EI-15333: a generic (non-no-such-repo) dial failure does NOT arm the backoff — retried next tick', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // live, no .errored
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: half-dead channel' }),
      );

      await runBootstrapLeg(SLUG, WS);
      await runBootstrapLeg(SLUG, WS);
      // Both ticks actually dialed — no backoff was armed for a non-no-such-repo failure.
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(2);
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EI-15333: backoff on one peer does not block dialing a DIFFERENT candidate', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async (_t: Buffer, device: string) => ({
      on: (_ev: string, _cb: () => void) => {},
      destroyed: false,
      errored: device === PEER_DEVICE ? new Error('pot-git serve refused: no-such-repo') : undefined,
    }));
    bootstrapFromPeerMock
      .mockImplementationOnce(bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'no-such-repo' }))
      .mockImplementation(bootstrapOutcome({ ok: true, namespaces: ['abcd1234'], skippedExisting: [], skippedSelf: null, stderr: '' }));

    await runBootstrapLeg(SLUG, WS); // arms backoff on PEER_DEVICE, succeeds via PEER_DEVICE_2
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2);

    // Reset and re-run: PEER_DEVICE_2's namespace is now present locally
    // (as bootstrapFromPeer's real effect would leave it), so the warm gate
    // short-circuits before any dialing on this next tick — never even
    // reaching the point where PEER_DEVICE's backoff would matter.
    const peer2Hex = Buffer.from(PEER_DEVICE_2, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peer2Hex]);
    openHiveGitDuplexToDeviceMock.mockClear();
    bootstrapFromPeerMock.mockClear();
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled(); // warm — no dialing needed at all
  });
});
