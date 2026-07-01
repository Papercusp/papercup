/**
 * coord:catch-up ↔ audience-host IMPORTER-BOUNDARY guard
 * (presence-coord-unification-2026-07-01 P-009 / regression guard for WI-1352).
 *
 * WI-1352 was a RUNTIME crash: catch-up.ts imports `canonicalizeAudienceSelector`
 * from ../audience-host, but the committed/deployed module did NOT export it, so any
 * operator running committed code (main / :3070) crashed with
 * "(0 , import_audience_host.canonicalizeAudienceSelector) is not a function".
 * It slipped past CI because the tool-level catch-up.test.ts MOCKS ../audience-host,
 * hiding the committed-importer + missing-export WIRING. audience-host.test.ts guards
 * the module in ISOLATION (its own un-mocked import), but nothing exercised the export
 * path THROUGH the real importer.
 *
 * This suite is that missing coverage: it imports the REAL catch-up tool with
 * ../audience-host UN-MOCKED and drives `canonicalizeAudienceSelector` THROUGH the
 * handler. A missing / renamed / non-callable export now crashes THIS test at the
 * importer boundary — not just the module-level audience-host.test.ts.
 *
 * PG-free by construction: the reject path returns before any resolver runs; the fleet
 * + `*` paths are exercised with only the PG boundary (../presence-fleet + ../feed)
 * stubbed, so ../audience-host itself stays REAL.
 */
import { describe, it, expect, vi } from 'vitest';

// Fixed caller identity = 'me' (keeps ctx/env assumptions out of the wiring test).
vi.mock('../identity', async (orig) => {
  const actual = await orig<typeof import('../identity')>();
  return {
    ...actual,
    resolveAgentIdentity: () => ({
      ownerId: 'me',
      ownerLabel: 'me',
      source: 'omp-hook-session',
      workspaceId: 'default',
      userId: null,
    }),
  };
});

// Stub ONLY the PG boundary — deliberately NOT ../audience-host (the whole point). The
// caller is reported a member of 'backend-team' so the fleet path clears its gate.
vi.mock('../presence-fleet', () => ({
  fetchPresenceFleet: async (ids: string[]) =>
    new Map<string, { fleetSlug: string; fleetRole: string }>(
      ids.includes('me') ? [['me', { fleetSlug: 'backend-team', fleetRole: 'member' }]] : [],
    ),
}));

// Keep MAX_FEED_LIMIT (consumed by the args schema at module load); stub readCoordFeed
// so no PG feed read runs.
vi.mock('../feed', async (orig) => {
  const actual = await orig<typeof import('../feed')>();
  return {
    ...actual,
    readCoordFeed: async () => ({ rows: [], nextCursor: null, total: 0, tokens: 0 }),
  };
});

import catchUp from './catch-up';

const ctx = { uiClientId: 'me', isSuperuser: true, workspaceId: 'default' } as never;

function run(args: Record<string, unknown>) {
  const parsed = (catchUp.args as { parse: (x: unknown) => unknown }).parse(args);
  return catchUp.handler(parsed as never, ctx);
}
function isError(res: unknown): boolean {
  return (res as { isError?: boolean }).isError === true;
}
function payload(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0]!.text);
}

describe('coord:catch-up × REAL audience-host — importer-boundary export guard (P-009 / WI-1352)', () => {
  it('invokes the REAL canonicalizeAudienceSelector THROUGH the importer — a missing export crashes HERE, not just in the module test', async () => {
    // 'not-a-selector' takes the PG-free reject path, but the handler calls the real
    // canonicalizeAudienceSelector (catch-up.ts line 81) BEFORE the membership gate — so
    // this alone throws "is not a function" if catch-up.ts's import resolves to undefined.
    const res = await run({ audience: 'not-a-selector' });
    expect(isError(res)).toBe(true);
    expect(payload(res as { content: { text: string }[] }).error).toContain('not an audience selector');
  });

  it('canonicalizes a human fleet name to its slug via the real module end-to-end (Backend Team → backend-team)', async () => {
    const res = await run({ audience: '@fleet:Backend Team' });
    expect(isError(res)).toBe(false);
    // Proves the REAL canonicalizeAudienceSelector ran through catch-up.ts (not a stub):
    // the human name was slugified to the stored key.
    expect(payload(res as { content: { text: string }[] }).audience).toBe('@fleet:backend-team');
  });

  it("passes '*' through the real module as-typed (broadcast needs no membership check)", async () => {
    const res = await run({ audience: '*' });
    expect(isError(res)).toBe(false);
    expect(payload(res as { content: { text: string }[] }).audience).toBe('*');
  });
});
