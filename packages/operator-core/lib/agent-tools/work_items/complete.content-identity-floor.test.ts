/**
 * EI-21502635666260946 — `committedCloseDowngradedForUnprovenContentIdentity`:
 * the write-time half of the completion content-identity floor.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A `committed` close claims the strongest completion authority, but it is only
 * honest when the server PROVED every declared `filesChanged` path has identical
 * Git blob content in the working tree and committed HEAD. Before this rule was
 * extracted, it lived inline in the work_items:complete handler with zero test
 * coverage — and while the release gate froze an older build live, that build
 * minted exactly the close the current source would have downgraded (observed on
 * WI-41491: closed 2026-08-26T01:43:40Z with `authority=committed` and a
 * treeStamp carrying NO contentIdentity over four declared paths).
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * Falsifiability is structural, both directions: every "DOWNGRADES" case names a
 * specific unproven shape (missing identity / JSON-null blob / mismatched blobs /
 * empty identity), and every "KEEPS committed" case would fail a degenerate
 * implementation that downgraded everything. The WI-41491 control pins the exact
 * persisted shape that started the bug class.
 *
 * The SQL mirror of this truth table lives in migration 972
 * (harness_shared.completion_content_identity_proven) and is exercised against a
 * real Postgres by
 * libs/papercusp/libs/db/src/completion-authority-content-identity-floor-migration.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { committedCloseDowngradedForUnprovenContentIdentity } from './completion-freshness';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '0000111122223333444455556666777788889999';

describe('committedCloseDowngradedForUnprovenContentIdentity (EI-21502635666260946)', () => {
  describe('DOWNGRADES unproven shapes', () => {
    it('downgrades the exact WI-41491 shape: treeStamp without any contentIdentity', () => {
      // Persisted verbatim from harness_shared.work_items WI-41491: headSha +
      // repositoryRoot only, four declared filesChanged paths, zero identity.
      expect(
        committedCloseDowngradedForUnprovenContentIdentity(
          'committed',
          [
            'apps/operator/bin/release/dependency-generation.sh',
            'apps/operator/lib/release/dependency-generation.test.ts',
            'apps/operator/lib/release/green-checkpoint.ts',
            'apps/operator/lib/release/green-checkpoint-real-deps.test.ts',
          ],
          {
            repositoryRoot: '/home/builduser/papercupai-workspace/papercusp',
            headSha: '1e26e2d89e97c5aa6956213d462b0fc3cd31f7ad',
          },
        ),
      ).toBe(true);
    });

    it('downgrades when a declared path is absent from HEAD (null headBlobSha)', () => {
      expect(
        committedCloseDowngradedForUnprovenContentIdentity(
          'committed',
          ['src/fix.ts', 'src/new-fix.ts'],
          {
            repositoryRoot: '/repo',
            headSha: SHA,
            contentIdentity: [
              { path: 'src/fix.ts', workingTreeBlobSha: SHA, headBlobSha: SHA },
              { path: 'src/new-fix.ts', workingTreeBlobSha: SHA, headBlobSha: null },
            ],
          },
        ),
      ).toBe(true);
    });

    it('downgrades when working-tree and HEAD blobs diverge', () => {
      expect(
        committedCloseDowngradedForUnprovenContentIdentity('committed', ['src/fix.ts'], {
          repositoryRoot: '/repo',
          headSha: SHA,
          contentIdentity: [{ path: 'src/fix.ts', workingTreeBlobSha: OTHER_SHA, headBlobSha: SHA }],
        }),
      ).toBe(true);
    });

    it('downgrades a present-but-empty identity array', () => {
      expect(
        committedCloseDowngradedForUnprovenContentIdentity('committed', ['src/fix.ts'], {
          repositoryRoot: '/repo',
          headSha: SHA,
          contentIdentity: [],
        }),
      ).toBe(true);
    });
  });

  describe('KEEPS committed when identity is proven', () => {
    it('keeps committed when every declared path proves blob equality', () => {
      expect(
        committedCloseDowngradedForUnprovenContentIdentity(
          'committed',
          ['src/fix.ts', 'src/other.ts'],
          {
            repositoryRoot: '/repo',
            headSha: SHA,
            contentIdentity: [
              { path: 'src/fix.ts', workingTreeBlobSha: SHA, headBlobSha: SHA },
              { path: 'src/other.ts', workingTreeBlobSha: OTHER_SHA, headBlobSha: OTHER_SHA },
            ],
          },
        ),
      ).toBe(false);
    });

    it('keeps a weaker authority untouched — only `committed` claims are policed', () => {
      expect(committedCloseDowngradedForUnprovenContentIdentity('proposed', ['src/fix.ts'], undefined)).toBe(
        false,
      );
    });

    it('keeps committed when no paths were declared — nothing to prove', () => {
      expect(committedCloseDowngradedForUnprovenContentIdentity('committed', [], undefined)).toBe(false);
      expect(committedCloseDowngradedForUnprovenContentIdentity('committed', undefined, undefined)).toBe(
        false,
      );
    });
  });
});
