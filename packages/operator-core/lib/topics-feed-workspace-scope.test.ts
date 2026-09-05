/**
 * topics-feed-workspace-scope.test.ts — pins the ONE property that made the
 * whole `topics:*` read surface silently return nothing (EI-20212219297008492).
 *
 * THE BUG. `topics-feed.ts` constructed its `PgTaggableStore` with a STATIC
 * `workspaceId: DEFAULT_COORD_WORKSPACE` (the literal `'default'`), while every
 * WRITER of those same `coord_links rel='tagged'` edges had moved to the live
 * coord scope — `work-items.ts` (`getWorkspaceId: () => activeWorkspaceId()`)
 * and `issues-engineer.ts` (`getWorkspaceId: () => coordScopeWorkspace()`). The
 * reader was left behind by that cutover. Measured on the live box 2026-09-05,
 * `coord_links` where rel='tagged' and dst_kind='topic':
 *
 *   workspace_id='papercusp-workspace'   159,351 edges   (newest: minutes old)
 *   workspace_id='default'                 1,487 edges   (newest: 2026-08-22)
 *
 * — so the reader addressed 0.92% of the data and nothing recent. The failure
 * mode is an EMPTY FEED, indistinguishable from "nothing is tagged with that",
 * which is why it survived long enough for the surface to look like dead code.
 *
 * WHY THE EXISTING INTEGRATION TEST COULD NOT CATCH IT.
 * `topics-feed.integration.test.ts` tags via `tagObject` and reads via
 * `topicFeed` — BOTH through this module's own store. It is self-consistent by
 * construction: it passes under any workspace value, including a wrong one, so
 * it can never detect divergence from the real writers. That is precisely the
 * shape of test that lets this class of bug live. This file tests the seam
 * itself instead of a round-trip through it.
 *
 * WHAT IS ASSERTED. Not a literal string — pinning `'papercusp-workspace'` would
 * just re-freeze the bug at a different value. The invariant is that the store
 * resolves its workspace DYNAMICALLY, tracking `coordScopeWorkspace()` at call
 * time. A static literal cannot track a changing scope; a dynamic seam must.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Mutable stand-in for the live coord scope, so we can watch the seam follow it. */
const scope = { value: 'ws-initial' };

/** Construction opts as the capability stores accept them. */
interface CapabilityStoreOpts {
  workspaceId?: string;
  getWorkspaceId?: () => string;
}

/**
 * THE JUDGE — applied identically to the real module and to the controls below,
 * so a control cannot pass for a different reason than the subject fails.
 *
 * Returns `null` for "could not measure" rather than a falsy verdict, so an
 * unreachable/absent seam can never read as a clean pass.
 */
function workspaceSeamVerdict(opts: CapabilityStoreOpts | null): { dynamic: boolean; tracksScope: boolean } | null {
  if (!opts) return null;
  if (typeof opts.getWorkspaceId !== 'function') return { dynamic: false, tracksScope: false };
  const before = scope.value;
  try {
    scope.value = 'ws-alpha';
    const a = opts.getWorkspaceId();
    scope.value = 'ws-beta';
    const b = opts.getWorkspaceId();
    return { dynamic: true, tracksScope: a === 'ws-alpha' && b === 'ws-beta' };
  } finally {
    scope.value = before;
  }
}

/** Captured construction opts from the mocked PgTaggableStore. */
let capturedOpts: CapabilityStoreOpts | null = null;

async function loadTopicsFeed(): Promise<void> {
  capturedOpts = null;
  vi.resetModules();

  vi.doMock('@papercusp/coordination/capabilities', () => ({
    PgTaggableStore: class {
      constructor(opts: CapabilityStoreOpts) {
        capturedOpts = opts;
      }
      async addTag(): Promise<void> {}
      async removeTag(): Promise<void> {}
      async listTags(): Promise<string[]> {
        return [];
      }
      async listTagged(): Promise<unknown[]> {
        return [];
      }
    },
  }));
  vi.doMock('@papercusp/db-org', () => ({
    getOrgPg: () => ({ sql: (() => []) as unknown }),
  }));
  vi.doMock('./agent-tools/coordination/log', () => ({
    coordScopeWorkspace: () => scope.value,
  }));

  await import('./topics-feed');
}

beforeEach(() => {
  scope.value = 'ws-initial';
});

describe('topics-feed workspace seam', () => {
  it('constructs its taggable store with a DYNAMIC workspace seam that tracks coordScopeWorkspace()', async () => {
    await loadTopicsFeed();

    const verdict = workspaceSeamVerdict(capturedOpts);

    // A null verdict means the store was never constructed — a failed
    // measurement, not a pass. Assert it explicitly so it cannot slip through.
    expect(verdict, 'PgTaggableStore was never constructed — the probe did not measure the seam').not.toBeNull();
    expect(verdict?.dynamic, 'topics-feed.ts must pass getWorkspaceId, not a frozen workspaceId literal').toBe(true);
    expect(verdict?.tracksScope, 'the seam must re-resolve coordScopeWorkspace() on every call').toBe(true);
  });

  it('does not pin a hardcoded workspace literal alongside the dynamic seam', async () => {
    await loadTopicsFeed();

    // A leftover static `workspaceId` is dead weight at best and, if the dynamic
    // seam ever returns empty, the store falls back to it — silently restoring
    // exactly the bug this file exists to prevent (see the `ws` getter:
    // `getWorkspaceId?.()?.trim() || (workspaceId ?? DEFAULT_COORD_WORKSPACE)`).
    expect(capturedOpts?.workspaceId).toBeUndefined();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // FALSIFIABILITY CONTROLS — permanent, so the judge above is never vacuous.
  // These run the SAME `workspaceSeamVerdict` over known-good and known-bad
  // shapes. If the judge ever stops discriminating, these fail first.
  // ───────────────────────────────────────────────────────────────────────────
  describe('controls', () => {
    it('CATCHES the pre-fix shape: a static workspaceId literal', () => {
      const verdict = workspaceSeamVerdict({ workspaceId: 'default' });
      expect(verdict).toEqual({ dynamic: false, tracksScope: false });
    });

    it('CATCHES a seam that is dynamic in shape but ignores the live scope', () => {
      const verdict = workspaceSeamVerdict({ getWorkspaceId: () => 'default' });
      expect(verdict).toEqual({ dynamic: true, tracksScope: false });
    });

    it('ACCEPTS a seam that re-reads the live scope', () => {
      const verdict = workspaceSeamVerdict({ getWorkspaceId: () => scope.value });
      expect(verdict).toEqual({ dynamic: true, tracksScope: true });
    });

    it('reports an unmeasurable seam as null rather than a pass', () => {
      expect(workspaceSeamVerdict(null)).toBeNull();
    });
  });
});
