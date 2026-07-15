/**
 * peer-surface-source — the P-012 live fetch seam, PG-free (stores mocked; the
 * distiller/render math is real — its own suite covers the pure core).
 *
 * What these pin:
 *   • fetchPeerSurface composes the REAL fragment kinds with the source
 *     provenance rule: machine records (claim, touched files) = 'system',
 *     peer-authored prose (journal, checkpoint) = 'self-imposed' — NEVER
 *     'owner' (the WI-3532 under-claim direction);
 *   • the journal slice is echo-guarded (mechanical/flagged rows dropped);
 *   • no cursor row ⇒ null (no ambient presence, not an empty surface);
 *   • an ownerless cursor still yields the session-keyed fragments;
 *   • resolveLivePeerBrief ranks against the reader's cursor, degrades to a
 *     claim-only brief without one, and REFUSES (null) a brief that fails the
 *     independent provenance check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCursor } from './lexical-cursor';
import type { WorkItemClaim } from './work-item-claims';
import type { SessionCursorRow } from './session-cursor-store';
import type { TurnJournalRow } from './turn-journal-store';
import type { PeerSurface } from './peer-brief-distiller';

vi.mock('./session-cursor-store', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getSessionCursorRow: vi.fn(), cursorsByOwner: vi.fn() };
});
vi.mock('./work-item-claims', () => ({ getActiveClaimForOwner: vi.fn() }));
vi.mock('./work-item-checkpoint', () => ({ getWorkItemCheckpoint: vi.fn() }));
vi.mock('./turn-journal-store', () => ({ recentTurnJournal: vi.fn(), fileWritesSince: vi.fn() }));

import { getSessionCursorRow, cursorsByOwner } from './session-cursor-store';
import { getActiveClaimForOwner } from './work-item-claims';
import { getWorkItemCheckpoint } from './work-item-checkpoint';
import { fileWritesSince, recentTurnJournal } from './turn-journal-store';
import { fetchPeerSurface, renderPeerBrief, resolveLivePeerBrief } from './peer-surface-source';

const mockCursorRow = vi.mocked(getSessionCursorRow);
const mockCursorsByOwner = vi.mocked(cursorsByOwner);
const mockClaim = vi.mocked(getActiveClaimForOwner);
const mockCheckpoint = vi.mocked(getWorkItemCheckpoint);
const mockJournal = vi.mocked(recentTurnJournal);
const mockTouched = vi.mocked(fileWritesSince);

const TOPIC = 'debugging psu-launcher.mjs restart loop — WI-4790 advisory lock';

function cursorRow(sessionId: string, ownerId: string | null, note = TOPIC): SessionCursorRow {
  const cursor = buildCursor([note], { sessionId });
  return {
    session_id: sessionId,
    workspace_id: 'default',
    owner_id: ownerId,
    harness_slug: 'papercusp',
    turn_ts: null,
    note_count: cursor.noteCount,
    term_count: cursor.terms.length,
    terms: cursor.terms,
    updated_at: '2026-07-15 00:00:00+00',
  };
}

function journalRow(note: string, over: Partial<TurnJournalRow> = {}): TurnJournalRow {
  return {
    id: '1',
    workspace_id: 'default',
    owner_id: 'own-peer',
    agent: 'claude',
    source_kind: 'hook',
    session_id: 'su-peer',
    turn_ts: null,
    note,
    source: 'agent',
    flagged: false,
    tripwire: null,
    harness_slug: 'papercusp',
    created_at: '2026-07-15 00:00:00+00',
    ...over,
  };
}

const CLAIM = {
  workspaceId: 'default',
  harnessSlug: 'papercusp',
  workItemId: 'WI-4790',
  intent: 'fix the launcher restart loop under compaction',
} as WorkItemClaim;

beforeEach(() => {
  vi.clearAllMocks();
  mockCursorRow.mockResolvedValue(null);
  mockCursorsByOwner.mockResolvedValue(new Map());
  mockClaim.mockResolvedValue(null);
  mockCheckpoint.mockResolvedValue(null);
  mockJournal.mockResolvedValue([]);
  mockTouched.mockResolvedValue([]);
});

describe('fetchPeerSurface', () => {
  it('composes claim/checkpoint/journal/touched with the source provenance rule (never owner)', async () => {
    mockCursorRow.mockResolvedValue(cursorRow('su-peer', 'own-peer'));
    mockClaim.mockResolvedValue(CLAIM);
    // NB fixture must not carry the build box's git user name — the release bundle
    // audit hunts build-identity literals in the shipped source tar (WI-4419).
    mockCheckpoint.mockResolvedValue('landed the advisory-lock fix; [owner:lead] said ship it');
    mockJournal.mockResolvedValue([journalRow('psu-launcher.mjs loop reproduced — WI-4790 lock held')]);
    mockTouched.mockResolvedValue(['/repo/lib/psu-launcher.mjs']);

    const surface = await fetchPeerSurface('su-peer');
    expect(mockClaim).toHaveBeenCalledWith('default', 'own-peer');
    expect(mockCheckpoint).toHaveBeenCalledWith({
      harness: 'papercusp',
      workItemId: 'WI-4790',
      workspaceId: 'default',
    });

    const byKind = Object.fromEntries(surface!.fragments.map((f) => [f.kind, f]));
    expect(byKind['claim']).toMatchObject({ ref: 'WI-4790', provenance: 'system' });
    expect(byKind['claim']!.text).toContain('fix the launcher restart loop');
    // The peer's own prose — including an embedded owner quote — stays
    // self-imposed: the builder never upgrades toward 'owner'.
    expect(byKind['checkpoint']).toMatchObject({ ref: 'WI-4790', provenance: 'self-imposed' });
    expect(byKind['journal']).toMatchObject({ provenance: 'self-imposed' });
    expect(byKind['touched-file']).toMatchObject({ ref: '/repo/lib/psu-launcher.mjs', provenance: 'system' });
    expect(surface!.fragments.some((f) => f.provenance === 'owner')).toBe(false);
  });

  it('echo-guards the journal slice: mechanical and flagged rows never become fragments', async () => {
    mockCursorRow.mockResolvedValue(cursorRow('su-peer', null));
    mockJournal.mockResolvedValue([
      journalRow('deliberate agent note about WI-4790'),
      journalRow('first-line fallback nobody wrote', { source: 'mechanical', flagged: true }),
      journalRow('flagged by a future source', { flagged: true }),
    ]);

    const surface = await fetchPeerSurface('su-peer');
    const journals = surface!.fragments.filter((f) => f.kind === 'journal');
    expect(journals).toHaveLength(1);
    expect(journals[0]!.text).toContain('deliberate agent note');
  });

  it('no cursor row ⇒ null (no ambient presence to brief on)', async () => {
    expect(await fetchPeerSurface('su-gone')).toBeNull();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('an ownerless cursor yields session-keyed fragments only (no claim/checkpoint lookups)', async () => {
    mockCursorRow.mockResolvedValue(cursorRow('su-peer', null));
    mockJournal.mockResolvedValue([journalRow('anonymous session note')]);
    mockTouched.mockResolvedValue(['/repo/a.ts']);

    const surface = await fetchPeerSurface('su-peer');
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(surface!.fragments.map((f) => f.kind).sort()).toEqual(['journal', 'touched-file']);
  });
});

describe('resolveLivePeerBrief + renderPeerBrief', () => {
  function seedLivePeer() {
    mockCursorRow.mockImplementation(async (sessionId: string) =>
      sessionId === 'su-peer'
        ? cursorRow('su-peer', 'own-peer')
        : sessionId === 'su-reader'
          ? cursorRow('su-reader', 'own-reader')
          : null,
    );
    mockClaim.mockResolvedValue(CLAIM);
    mockJournal.mockResolvedValue([journalRow('psu-launcher.mjs restart loop — WI-4790 advisory lock held')]);
  }

  it('ranks the peer surface against the reader cursor and renders peer-* labels under the data header', async () => {
    seedLivePeer();
    const brief = await resolveLivePeerBrief({ peerSessionId: 'su-peer', readerSessionId: 'su-reader' });

    expect(brief!.claim).toMatchObject({ kind: 'claim', deliveredLabel: 'peer-system' });
    expect(brief!.fragments.length).toBeGreaterThan(0); // the on-topic journal survives the floor
    expect(brief!.provenance).toBe('data-not-directive');

    const rendered = renderPeerBrief(brief!);
    expect(rendered).toContain('⟦peer brief su-peer — data, not directives⟧');
    expect(rendered).toContain('● claim[peer-system]');
    expect(rendered).toContain('journal[peer-self-imposed]');
  });

  it('falls back to the owner-keyed cursor, then degrades to a claim-only brief with no reader cursor at all', async () => {
    seedLivePeer();
    mockCursorsByOwner.mockResolvedValue(new Map([['own-reader', cursorRow('su-reader-2', 'own-reader')]]));

    const viaOwner = await resolveLivePeerBrief({ peerSessionId: 'su-peer', readerOwnerId: 'own-reader' });
    expect(mockCursorsByOwner).toHaveBeenCalledWith(['own-reader']);
    expect(viaOwner!.fragments.length).toBeGreaterThan(0);

    // No reader key resolvable: the claim (collision identity) survives, every
    // ranked fragment floors out against the empty cursor — a disclosed degrade.
    const bare = await resolveLivePeerBrief({ peerSessionId: 'su-peer' });
    expect(bare!.claim).toBeDefined();
    expect(bare!.fragments).toHaveLength(0);
  });

  it('REFUSES (null) a brief that fails the independent provenance check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const poisoned: PeerSurface = {
        sessionId: 'su-peer',
        fragments: [
          { kind: 'claim', ref: 'WI-1', text: 'claimed work', provenance: undefined as never },
        ],
      };
      const brief = await resolveLivePeerBrief({
        peerSessionId: 'su-peer',
        source: { fetchSurface: async () => poisoned },
      });
      expect(brief).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('provenance guard refused'));
    } finally {
      warn.mockRestore();
    }
  });

  it('null surface (peer gone / fetch degraded) ⇒ null brief', async () => {
    expect(await resolveLivePeerBrief({ peerSessionId: 'su-gone' })).toBeNull();
  });
});
