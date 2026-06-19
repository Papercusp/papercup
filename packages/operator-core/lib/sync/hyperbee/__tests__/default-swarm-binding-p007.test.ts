/**
 * P-007 (shared-hive-federation) — the single-harness sub-share is preserved
 * under Hive membership.
 *
 * A harness that is NOT a member of a shared (owner-published) Hive must keep
 * its own per-harness gh/local swarm binding — the "guest to one repo / fork-PR"
 * sub-share path — after the P-004 Hive topic re-key. `defaultResolveSwarmBinding`
 * gives a published-Hive binding PRECEDENCE, and falls through to the per-harness
 * gh binding when `resolveHiveSwarmBinding` returns null (a non-member / private /
 * un-published Hive). The null gate itself is exhaustively covered by
 * `hive-federation.test.ts` (6 cases); this pins the CALLER's two branches
 * directly so the sub-share preservation is asserted end-to-end, not by inspection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the three deps `defaultResolveSwarmBinding` consults. The relative paths
// here (from __tests__/) resolve to the SAME module ids as the in-function
// dynamic imports in boot-all.ts (../../hive-federation, ../../resolve-harness-paths)
// + its static import (../../harness/load-shared-config), so the mocks apply to both.
vi.mock('../../../hive-federation', () => ({
  resolveHiveSwarmBinding: vi.fn(),
}));
vi.mock('../../../resolve-harness-paths', () => ({
  resolveHarnessPaths: vi.fn(),
}));
vi.mock('../../../harness/load-shared-config', () => ({
  loadSharedConfigFromProjectDir: vi.fn(),
}));

import { defaultResolveSwarmBinding } from '../boot-all';
import { resolveHiveSwarmBinding } from '../../../hive-federation';
import { resolveHarnessPaths } from '../../../resolve-harness-paths';
import { loadSharedConfigFromProjectDir } from '../../../harness/load-shared-config';

const mockHive = vi.mocked(resolveHiveSwarmBinding);
const mockPaths = vi.mocked(resolveHarnessPaths);
const mockCfg = vi.mocked(loadSharedConfigFromProjectDir);

afterEach(() => vi.clearAllMocks());

describe('P-007 — single-harness sub-share preserved under Hive membership', () => {
  it('a published-Hive member federates over the Hive binding (precedence; gh path not consulted)', async () => {
    mockHive.mockResolvedValue({ kind: 'hive', hive_pubkey: 'PUBKEY_B64' } as never);

    const got = await defaultResolveSwarmBinding('ws', 'member-harness');

    expect(got).toEqual({ kind: 'hive', hive_pubkey: 'PUBKEY_B64' });
    // The per-harness gh path must NOT be reached when a Hive binding exists.
    expect(mockPaths).not.toHaveBeenCalled();
    expect(mockCfg).not.toHaveBeenCalled();
  });

  it('a NON-Hive harness with a committed shared.json keeps its per-harness gh binding (the sub-share)', async () => {
    mockHive.mockResolvedValue(null);
    mockPaths.mockResolvedValue({ projectDir: '/real/project/dir' } as never);
    mockCfg.mockReturnValue({ github_repository_id: 7 } as never);

    const got = await defaultResolveSwarmBinding('ws', 'fork-pr-harness');

    expect(got).toEqual({ kind: 'gh', github_repository_id: 7 });
  });

  it('a NON-Hive harness with no shared.json resolves to null (no swarm join)', async () => {
    mockHive.mockResolvedValue(null);
    mockPaths.mockResolvedValue({ projectDir: '/real/project/dir' } as never);
    mockCfg.mockReturnValue(null);

    const got = await defaultResolveSwarmBinding('ws', 'local-only-harness');

    expect(got).toBeNull();
  });

  it('an un-backfilled/unresolved harness (placeholder projectDir) resolves to null', async () => {
    mockHive.mockResolvedValue(null);
    mockPaths.mockResolvedValue({ projectDir: '/tmp/papercusp-unresolved/xyz' } as never);

    const got = await defaultResolveSwarmBinding('ws', 'unresolved-harness');

    expect(got).toBeNull();
    expect(mockCfg).not.toHaveBeenCalled();
  });
});

describe('the join-vs-owner topic-split fix — a joiner honors its link topic', () => {
  // The OWNER federates on `hive:<pubkey>`; the member link the joiner persisted
  // into its shared.json carries THAT 32-byte topic (64 hex) but NOT the pubkey.
  // The joiner cannot reconstruct a `hive:` binding (no pubkey), and `resolveHive-
  // SwarmBinding` returns null for it (it isn't an owned/published Hive home), so
  // it lands in branch (2). It MUST honor the stored topic verbatim — else re-
  // deriving `gh:<repo_id>` puts it on a DIFFERENT swarm topic than the owner and
  // no incremental write ever crosses (the initial join-handshake merge lands, then
  // sync silently dies). This pins the caller-level half of the fix; the topic
  // binding's verbatim derivation is pinned in derive-swarm-topic.test.ts.
  const LINK_TOPIC = 'a3f1'.repeat(16); // a valid 64-hex topic (the owner's Hive topic)

  it('a joiner whose shared.json carries the Hive topic federates on THAT topic, not gh:<repo_id>', async () => {
    mockHive.mockResolvedValue(null); // not recognized as an owned/published Hive home
    mockPaths.mockResolvedValue({ projectDir: '/real/project/dir' } as never);
    // The member link persisted BOTH the topic and the repo id into shared.json.
    mockCfg.mockReturnValue({ topic: LINK_TOPIC, github_repository_id: 42 } as never);

    const got = await defaultResolveSwarmBinding('ws', 'joined-hive-harness');

    expect(got).toEqual({ kind: 'topic', topic_hex: LINK_TOPIC });
    // The bug this guards: WITHOUT the fix it would split onto the gh-repo topic.
    expect(got).not.toEqual({ kind: 'gh', github_repository_id: 42 });
  });

  it('a malformed (non-64-hex) topic falls through to the gh binding — never strands the joiner', async () => {
    mockHive.mockResolvedValue(null);
    mockPaths.mockResolvedValue({ projectDir: '/real/project/dir' } as never);
    mockCfg.mockReturnValue({ topic: 'not-a-valid-topic', github_repository_id: 42 } as never);

    const got = await defaultResolveSwarmBinding('ws', 'joined-hive-harness');

    expect(got).toEqual({ kind: 'gh', github_repository_id: 42 });
  });
});
