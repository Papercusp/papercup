/**
 * source-provenance-resolve tests (coord-authority-hardening-2026-07-11 P-007):
 * typed fact sourceRef → assert-time verification stamp. The two IO seams are
 * the SHARED D-004 resolvers — hydrateRefs (msg / work-item) and the H2 tier-2
 * relay resolver (owner-turn) — mocked WHOLESALE here so their store import
 * chains never load (the flags/server partial-mock trap: a partially-mocked
 * @papercusp/flags/server suite explodes when ref-hydrate-resolve's chain pulls
 * coordination/log → onFlagChange).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../coordination/ref-hydrate-resolve', () => ({ hydrateRefs: vi.fn() }));
vi.mock('../coordination/relay-provenance-resolve', () => ({ resolveRelayProvenance: vi.fn() }));

import { resolveFactSourceProvenance } from './source-provenance-resolve';
import { hydrateRefs } from '../coordination/ref-hydrate-resolve';
import { resolveRelayProvenance } from '../coordination/relay-provenance-resolve';
import { FACT_PROVENANCE_QUOTE_CHARS } from '../../agent-facts/store';
import type { AgentIdentity } from '../coordination/identity';

const IDENTITY = {
  ownerId: 'su-asserter',
  ownerLabel: 'a',
  source: 'static-client',
  workspaceId: 'ws-x',
  userId: null,
} as unknown as AgentIdentity;

beforeEach(() => vi.clearAllMocks());

describe('resolveFactSourceProvenance', () => {
  it('free-text sourceRefs are NOT typed refs → null (unchanged legacy anchor), no resolver called', async () => {
    for (const freeText of ['a-plan-slug-2026-07-11', 'proved by observation', 'docs/agent-insights/x']) {
      expect(await resolveFactSourceProvenance(IDENTITY, freeText)).toBeNull();
    }
    expect(hydrateRefs).not.toHaveBeenCalled();
    expect(resolveRelayProvenance).not.toHaveBeenCalled();
  });

  it('gate:/plan-item refs are outside the v1 typed set → null (stay free text)', async () => {
    expect(await resolveFactSourceProvenance(IDENTITY, 'gate:fleet:p2p:phase1')).toBeNull();
    expect(await resolveFactSourceProvenance(IDENTITY, 'plan:my-plan#P-003')).toBeNull();
    expect(hydrateRefs).not.toHaveBeenCalled();
  });

  it('msg:<id> — verified via the shared msg resolver, provenance-budgeted', async () => {
    vi.mocked(hydrateRefs).mockResolvedValue([
      {
        ref: { kind: 'msg', id: 'm-1' },
        ok: true,
        label: 'msg m-1 (15179 → 4c85f, 2026-07-11T09:01Z)',
        snippet: 'the verbatim origin',
      },
    ]);
    const stamp = await resolveFactSourceProvenance(IDENTITY, 'msg:m-1');
    expect(stamp).toMatchObject({
      kind: 'msg',
      verified: true,
      quote: 'the verbatim origin',
      label: 'msg m-1 (15179 → 4c85f, 2026-07-11T09:01Z)',
    });
    expect(typeof stamp?.verifiedAt).toBe('string');
    expect(vi.mocked(hydrateRefs).mock.calls[0]).toEqual([
      [{ kind: 'msg', id: 'm-1' }],
      { budget: { snippetChars: FACT_PROVENANCE_QUOTE_CHARS, maxRefs: 1 } },
    ]);
  });

  it('a bare WI id is a typed work-item ref; a miss stamps LOUD-unverified (assert never blocked)', async () => {
    vi.mocked(hydrateRefs).mockResolvedValue([
      { ref: { kind: 'work-item', id: 'WI-9999' }, ok: false, label: 'work-item:WI-9999', snippet: '', error: 'not_found' },
    ]);
    expect(await resolveFactSourceProvenance(IDENTITY, 'WI-9999')).toMatchObject({
      kind: 'work-item',
      verified: false,
      error: 'not_found',
    });
  });

  it('owner-turn — verified via the H2 tier-2 resolver; the fact carries the OWNER\'S verbatim words', async () => {
    vi.mocked(resolveRelayProvenance).mockResolvedValue({
      stamp: {
        tier: 'owner-verified-turn',
        quote: 'implement them all from start to finish yourself',
        origin: 'owner',
        sessionId: 's-1',
        turnTs: '2026-07-11T10:00:00Z',
      },
    });
    const stamp = await resolveFactSourceProvenance(IDENTITY, 'owner-turn');
    expect(stamp).toMatchObject({
      kind: 'owner-turn',
      verified: true,
      quote: 'implement them all from start to finish yourself',
      label: 'owner turn 2026-07-11T10:00:00Z',
    });
    expect(vi.mocked(resolveRelayProvenance)).toHaveBeenCalledWith(IDENTITY, { relayOf: 'owner-turn' });
  });

  it('owner-turn unresolvable (no live transcript window) → loud owner_turn_unresolved', async () => {
    vi.mocked(resolveRelayProvenance).mockResolvedValue({ stamp: { tier: 'unverified', quote: '' } });
    expect(await resolveFactSourceProvenance(IDENTITY, 'owner-turn')).toMatchObject({
      kind: 'owner-turn',
      verified: false,
      error: 'owner_turn_unresolved',
    });
  });

  it('session_turn owner-typed row → verified owner-turn stamp with canonical ref and recorded quote', async () => {
    const ref = 'session_turn:claude:session:with:colons:28';
    const loadSessionTurn = vi.fn().mockResolvedValue({
      sourceKind: 'claude',
      sessionId: 'session:with:colons',
      turnIdx: 28,
      speaker: 'user',
      text: 'TELL ALL AGENTS SYSTEM WIDE TO PAUSE THEIR WORK IMMEDIATELY',
      turnOrigin: null,
      turnOriginVerdict: 'owner-typed',
      ts: '2026-09-09T20:35:58Z',
    });

    await expect(resolveFactSourceProvenance(IDENTITY, ref, { loadSessionTurn })).resolves.toMatchObject({
      kind: 'owner-turn',
      verified: true,
      label: ref,
      quote: 'TELL ALL AGENTS SYSTEM WIDE TO PAUSE THEIR WORK IMMEDIATELY',
    });
    expect(loadSessionTurn).toHaveBeenCalledWith({
      sourceKind: 'claude',
      sessionId: 'session:with:colons',
      turnIdx: 28,
    });
  });

  it('session_turn owner-dialog is verified, while non-owner and unenrolled rows stay loud-unverified', async () => {
    const ref = 'session_turn:claude:session-a:4';
    const loadSessionTurn = vi.fn().mockResolvedValue({
      sourceKind: 'claude',
      sessionId: 'session-a',
      turnIdx: 4,
      speaker: 'user',
      text: 'ship the approved change',
      turnOrigin: null,
      turnOriginVerdict: 'owner-dialog',
    });
    await expect(resolveFactSourceProvenance(IDENTITY, ref, { loadSessionTurn })).resolves.toMatchObject({
      kind: 'owner-turn',
      verified: true,
    });

    loadSessionTurn.mockResolvedValueOnce({
      sourceKind: 'claude',
      sessionId: 'session-a',
      turnIdx: 4,
      speaker: 'user',
      text: 'replayed text',
      turnOrigin: 'loop-fire',
      turnOriginVerdict: 'agent-injected',
    });
    await expect(resolveFactSourceProvenance(IDENTITY, ref, { loadSessionTurn })).resolves.toMatchObject({
      kind: 'owner-turn',
      verified: false,
      error: 'owner_attribution_unverified',
    });

    loadSessionTurn.mockResolvedValueOnce(null);
    await expect(resolveFactSourceProvenance(IDENTITY, ref, { loadSessionTurn })).resolves.toMatchObject({
      kind: 'owner-turn',
      verified: false,
      error: 'not_found',
    });
  });

  it('a throwing resolver degrades to resolve_error — NEVER throws out of the assert path', async () => {
    vi.mocked(hydrateRefs).mockRejectedValue(new Error('store down'));
    expect(await resolveFactSourceProvenance(IDENTITY, 'msg:m-boom')).toMatchObject({
      kind: 'msg',
      verified: false,
      error: 'resolve_error',
    });
    vi.mocked(resolveRelayProvenance).mockRejectedValue(new Error('session store down'));
    expect(await resolveFactSourceProvenance(IDENTITY, 'owner-turn')).toMatchObject({
      kind: 'owner-turn',
      verified: false,
      error: 'resolve_error',
    });
    const loadSessionTurn = vi.fn().mockRejectedValue(new Error('index down'));
    await expect(resolveFactSourceProvenance(IDENTITY, 'session_turn:claude:s:1', { loadSessionTurn })).resolves.toMatchObject({
      kind: 'owner-turn',
      verified: false,
      error: 'resolve_error',
    });
  });
});
