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
type RegistryProject = { slug: string; hive_slug?: string; self_repo?: boolean };

const {
  loadHarnessRegistryMock,
  listHiveMembersMock,
  hiveGitRepoPathMock,
  listNamespacesMock,
  bootstrapFromPeerMock,
  resolveUsageActorMock,
  unsafeMock,
  getBootedHarnessMock,
  openHiveGitDuplexToDeviceMock,
} = vi.hoisted(() => ({
  loadHarnessRegistryMock: vi.fn<() => Promise<{ projects: RegistryProject[] }>>(async () => ({
    projects: [{ slug: 'shop-hive', hive_slug: 'shop-hive', self_repo: true }],
  })),
  listHiveMembersMock: vi.fn(async (_ws: string, _hive: string) => [
    { deviceAttestations: [{ device_pubkey: 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=' }] },
  ]),
  hiveGitRepoPathMock: vi.fn((potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  listNamespacesMock: vi.fn(async (_repoPath: string) => [] as string[]),
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
    duplex.on('error', () => {});
    return {
      ok: true,
      namespaces: ['abcd1234'],
      skippedExisting: [],
      skippedSelf: null,
      stderr: '',
    };
  }),
  resolveUsageActorMock: vi.fn(async () => ({ githubUserId: 1, devicePubkey: 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=' })),
  unsafeMock: vi.fn(async (_text: string, _params: unknown[]) => []),
}));

vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: loadHarnessRegistryMock }));
vi.mock('../../hive-membership-store', () => ({ listHiveMembers: listHiveMembersMock }));
vi.mock('../../sync/pot-git/storage', () => ({
  hiveGitRepoPath: hiveGitRepoPathMock,
  listNamespaces: listNamespacesMock,
}));
vi.mock('../../sync/pot-git/bootstrap', () => ({ bootstrapFromPeer: bootstrapFromPeerMock }));
vi.mock('../usage-actor', () => ({ resolveUsageActor: resolveUsageActorMock }));
vi.mock('../../sync/hyperbee/boot-all', () => ({ getBootedHarness: getBootedHarnessMock }));
vi.mock('../../sync/pot-git/peer-dial-registry', () => ({ openHiveGitDuplexToDevice: openHiveGitDuplexToDeviceMock }));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getOrgPg: () => ({ sql: { unsafe: unsafeMock } }) };
});

// Import AFTER the mocks so the module resolves the mocked deps.
import { runBootstrapLeg } from './git-sync-action';

const SLUG = 'shop-hive';
const WS = 'ws-1';

/** Every override below must keep consuming the duplex (attach a no-op
 *  'error' listener) exactly like the real fetchOverDuplex chain does now —
 *  see the vi.hoisted() comment above for why. */
const bootstrapOutcome = (result: BootstrapOutcome) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  duplex.on('error', () => {});
  return result;
};
const bootstrapRejection = (err: Error) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  duplex.on('error', () => {});
  throw err;
};

const SELF_DEVICE = 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=';
const PEER_DEVICE = 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=';

beforeEach(() => {
  loadHarnessRegistryMock.mockClear();
  listHiveMembersMock.mockClear();
  hiveGitRepoPathMock.mockClear();
  listNamespacesMock.mockClear();
  bootstrapFromPeerMock.mockClear();
  resolveUsageActorMock.mockClear();
  unsafeMock.mockClear();
  getBootedHarnessMock.mockClear();
  openHiveGitDuplexToDeviceMock.mockClear();
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
});

describe('runBootstrapLeg', () => {
  it('self-gates as a no-op when the local repo already has any namespace (warm repo)', async () => {
    listNamespacesMock.mockResolvedValue(['abcd1234']);
    await runBootstrapLeg(SLUG, WS);
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith(SLUG, SLUG);
    expect(listHiveMembersMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
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
    expect(hiveGitRepoPathMock).toHaveBeenCalledWith(SLUG, SLUG);
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

  it('falls back to the pre-WI-3583 destroyed stub (never dials) when no live swarm topic exists', async () => {
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
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
});
