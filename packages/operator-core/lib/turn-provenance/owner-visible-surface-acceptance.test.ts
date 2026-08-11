/**
 * Tests for the owner-visibility surface's LIVE-DRIVE acceptance
 * (plan owner-visibility-provenance-2026-08-11, P-007 / WI-37958).
 *
 * ⚠ READ THIS BEFORE ADDING A CASE. This suite is deliberately about the
 * REGISTRY AND ITS MATCHER, not about owner-visibility behaviour. That split is
 * the whole point of the item: on the owner-visibility surface itself a fixture
 * shares the code's blind spot and is close to worthless, which is why the
 * acceptance exists. Here, by contrast, the inputs ARE the author's to invent —
 * a path string and a `verifiedHow` value — so a fixture is the right
 * instrument. Do not let this file grow assertions about what the owner sees;
 * those belong to the live drive the registry is asking for.
 */
import { describe, expect, it } from 'vitest';

import {
  LIVE_DRIVE_ACCEPTED_VERIFICATIONS,
  OWNER_VISIBLE_SURFACE_FILES,
  liveDriveAcceptanceGap,
  liveDriveAcceptanceMessage,
  surfaceFilesTouched,
} from './owner-visible-surface-acceptance';

const SURFACE = 'packages/operator-core/lib/agent-tools/coordination/owner-chat-turn.ts';

describe('live-drive acceptance — when it fires', () => {
  it('FIRES on a unit-only close that changed the owner-visibility predicate', () => {
    const gap = liveDriveAcceptanceGap({ verifiedHow: 'unit', filesChanged: [SURFACE] });
    expect(gap).not.toBeNull();
    expect(gap!.surfaceFiles).toEqual([SURFACE]);
  });

  it('FIRES on `already-passing` too — the weakest claim of all on this surface', () => {
    expect(
      liveDriveAcceptanceGap({ verifiedHow: 'already-passing', filesChanged: [SURFACE] }),
    ).not.toBeNull();
  });

  it('FIRES when verifiedHow is absent entirely', () => {
    expect(liveDriveAcceptanceGap({ filesChanged: [SURFACE] })).not.toBeNull();
  });

  it('is SILENT once the surface was actually observed', () => {
    for (const how of LIVE_DRIVE_ACCEPTED_VERIFICATIONS) {
      expect(
        liveDriveAcceptanceGap({ verifiedHow: how, filesChanged: [SURFACE] }),
        `verifiedHow: ${how} should satisfy the acceptance`,
      ).toBeNull();
    }
  });

  /* ── The direction that must not regress. ────────────────────────────────
     A gate that fires on everything is a gate people learn to ignore, and an
     ignored gate is the checklist this item exists to replace. Every case
     below is an ordinary close that must sail through untouched. */

  it('is SILENT for a change that touches NO registered surface file', () => {
    expect(
      liveDriveAcceptanceGap({
        verifiedHow: 'unit',
        filesChanged: ['packages/operator-core/lib/some/unrelated-thing.ts'],
      }),
    ).toBeNull();
  });

  it('is SILENT when the completion records no filesChanged at all', () => {
    expect(liveDriveAcceptanceGap({ verifiedHow: 'unit' })).toBeNull();
    expect(liveDriveAcceptanceGap({ verifiedHow: 'unit', filesChanged: [] })).toBeNull();
  });

  it('is SILENT on undefined evidence (a completion that recorded nothing to judge)', () => {
    expect(liveDriveAcceptanceGap(undefined)).toBeNull();
  });
});

describe('live-drive acceptance — the path matcher', () => {
  it('matches a repo-relative path exactly', () => {
    expect(surfaceFilesTouched([SURFACE])).toEqual([SURFACE]);
  });

  it('matches an ABSOLUTE path, which is how completions often record it', () => {
    // Synthetic root on purpose: a real `/home/<user>/…` literal in shipped
    // source reds the green-checkpoint identity-lint leg and freezes `main`
    // for the whole fleet. The property under test is the leading slash, and
    // that is machine-independent.
    expect(surfaceFilesTouched([`/srv/checkout/papercusp/${SURFACE}`])).toEqual([SURFACE]);
  });

  it('tolerates a ./ prefix and backslash separators', () => {
    expect(surfaceFilesTouched([`./${SURFACE}`])).toEqual([SURFACE]);
    expect(surfaceFilesTouched([SURFACE.replace(/\//g, '\\')])).toEqual([SURFACE]);
  });

  it('does NOT match a file whose name merely ends the same way', () => {
    expect(
      surfaceFilesTouched([
        'packages/operator-core/lib/agent-tools/coordination/not-owner-chat-turn.ts',
      ]),
    ).toEqual([]);
  });

  it('does NOT match on basename alone — a same-named file elsewhere is a different file', () => {
    expect(surfaceFilesTouched(['some/other/package/owner-chat-turn.ts'])).toEqual([]);
  });

  it('de-duplicates when several recorded paths resolve to one surface file', () => {
    expect(surfaceFilesTouched([SURFACE, `./${SURFACE}`, `/abs/root/${SURFACE}`])).toEqual([
      SURFACE,
    ]);
  });

  it('survives a non-string entry without throwing — completions carry hand-written arrays', () => {
    expect(
      surfaceFilesTouched([null as unknown as string, SURFACE, 42 as unknown as string]),
    ).toEqual([SURFACE]);
  });
});

describe('live-drive acceptance — the registry itself', () => {
  it('every registered path is repo-relative and points at a real source file shape', () => {
    for (const p of OWNER_VISIBLE_SURFACE_FILES) {
      expect(p, `${p} must be repo-relative (no leading / or ./)`).toMatch(/^[a-z]/);
      expect(p, `${p} must name a source file`).toMatch(/\.tsx?$/);
    }
  });

  it('holds no duplicates — a duplicate would double-report one file in the message', () => {
    expect(new Set(OWNER_VISIBLE_SURFACE_FILES).size).toBe(OWNER_VISIBLE_SURFACE_FILES.length);
  });

  it('includes THE predicate and THE catalogue — the two files the leak has lived in', () => {
    expect(OWNER_VISIBLE_SURFACE_FILES).toContain(SURFACE);
    expect(OWNER_VISIBLE_SURFACE_FILES).toContain(
      'packages/operator-core/lib/turn-provenance/machine-surface-catalogue.ts',
    );
  });
});

describe('live-drive acceptance — the message', () => {
  it('names the item, the files, and what to do instead of just scolding', () => {
    const gap = liveDriveAcceptanceGap({ verifiedHow: 'unit', filesChanged: [SURFACE] })!;
    const msg = liveDriveAcceptanceMessage('WI-1234', gap);
    expect(msg).toContain('WI-1234');
    expect(msg).toContain(SURFACE);
    // The remedy has to be in the message, or the agent has to go find it.
    expect(msg).toContain('live-drove-ui');
    expect(msg).toContain('agent-e2e');
    // The REASON, not just the rule — an unexplained gate gets routed around.
    expect(msg).toMatch(/same hole|blind spot/i);
    // The escape hatch, so a genuinely-unrenderable change is not stuck.
    expect(msg).toContain('deferred');
  });
});
