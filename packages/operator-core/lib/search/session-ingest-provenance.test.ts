/**
 * Provenance stamped AT INGEST — plan owner-visibility-provenance-2026-08-11
 * P-004 (V-004), decision D-013.
 *
 * These tests pin the properties that make a PERSISTED verdict safe. A stored
 * column reads as authoritative in a way a live text match does not, so the
 * failure modes here are worse than the ones they replace — each test below
 * corresponds to a specific way this fix could silently become the very defect
 * it exists to remove.
 */

import { describe, it, expect } from 'vitest';
import { stampTurnProvenance } from './session-ingest';
import { MACHINE_SURFACE_CATALOGUE_VERSION } from '../turn-provenance/machine-surface-catalogue';
import { classifyRecordedTurn } from '../turn-provenance/turn-ref';

type Row = Parameters<typeof stampTurnProvenance>[0];

function row(over: Partial<Row> = {}): Row {
  return {
    workspace_id: 'default',
    source_kind: 'claude',
    session_id: 's-1',
    turn_idx: 0,
    ts: null,
    owner: 'su-1',
    harness_slug: 'papercusp',
    cwd: null,
    speaker: 'user',
    text: 'hello',
    ...over,
  } as Row;
}

describe('stampTurnProvenance', () => {
  it('records the ENVELOPE origin verbatim — the one field that is authored, not inferred', () => {
    const r = row({ text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nkeep going' });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('agent-injected');
    expect(r.turn_origin).toBe('loop-fire');
  });

  it.each([
    ['wake-pump', '⟦turn-origin:wake-pump nonce:a86e21b122a13757⟧\n[await-event] fired'],
    ['self-compaction', '⟦turn-origin:self-compaction nonce:7f6dfc8e97d0016f⟧\nContinue where you left off'],
    ['fleet-kickoff', '⟦turn-origin:fleet-kickoff nonce:deadbeefcafe1234⟧\nyour lane is X'],
  ])('classifies %s as agent-injected, never as the owner', (origin, text) => {
    const r = row({ text });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('agent-injected');
    expect(r.turn_origin).toBe(origin);
  });

  /**
   * THE 25,198-ROW TRAP. `classifyRecordedTurn` reaches `owner-typed` as the
   * RESIDUAL, and an assistant turn carries no envelope and matches no
   * machine-surface pattern — so an unguarded stamp marks every assistant turn
   * in the corpus as owner speech.
   */
  it('never stamps a non-user turn owner-typed — it gets the explicit not-user-turn verdict', () => {
    const text = 'Here is what I found.';

    // The guard is load-bearing, and THIS is the proof: handed the same text,
    // the bare classifier returns `owner-typed`. So the speaker check is the
    // only thing standing between this fix and stamping every assistant turn
    // in the corpus as owner speech. If someone deletes the guard, the
    // assertion below fails — and this line documents why it must not.
    expect(classifyRecordedTurn(text).verdict).toBe('owner-typed');

    const r = row({ speaker: 'assistant', text });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('not-user-turn');
    expect(r.turn_origin_verdict).not.toBe('owner-typed');
    expect(r.turn_origin).toBeNull();
  });

  it('stamps a genuinely clean owner turn owner-typed', () => {
    const r = row({ text: 'launch our windows vm please' });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('owner-typed');
    expect(r.turn_origin).toBeNull();
  });

  /**
   * HEAD-ANCHORING. A turn that QUOTES an envelope mid-body is an agent pasting
   * provenance as evidence — including this plan's own work. Classifying the
   * whole body would file the owner's message under the quoted origin.
   */
  it('does not classify a turn that merely QUOTES an envelope mid-body', () => {
    const r = row({
      text: `look at this weird thing I found in the logs: ⟦turn-origin:wake-pump nonce:abc123ef0123abcd⟧ — is that expected?`,
    });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).not.toBe('agent-injected');
    expect(r.turn_origin).toBeNull();
  });

  /**
   * NULL MUST MEAN EXACTLY ONE THING. Every row written by ingest carries a
   * version, so a NULL version in the table means "ingested before this feature
   * existed" and nothing else. If ingest could leave it NULL, a never-classified
   * row and a classified one become indistinguishable, and the backfill sweep
   * that repairs stale verdicts loses its only handle on them.
   */
  it.each(['user', 'assistant', 'system'])(
    'always stamps a non-null classifier version (speaker=%s)',
    (speaker) => {
      const r = row({ speaker, text: 'anything at all' });
      stampTurnProvenance(r);
      expect(r.turn_origin_classifier_version).toBe(MACHINE_SURFACE_CATALOGUE_VERSION);
      expect(r.turn_origin_classifier_version).not.toBeNull();
      expect(r.turn_origin_verdict).toBeTruthy();
    },
  );

  it('stamps every row it is given, so no adapter can opt out by accident', () => {
    const rows = [
      row({ source_kind: 'claude', speaker: 'user', text: 'hi' }),
      row({ source_kind: 'codex', speaker: 'assistant', text: 'done' }),
      row({ source_kind: 'omp', speaker: 'user', text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nx' }),
      row({ source_kind: 'agent_chat', speaker: 'user', text: 'what is the status' }),
    ];
    for (const r of rows) stampTurnProvenance(r);
    expect(rows.every((r) => r.turn_origin_verdict != null)).toBe(true);
    expect(rows.every((r) => r.turn_origin_classifier_version != null)).toBe(true);
  });

  it('is idempotent — re-stamping a row cannot drift its verdict', () => {
    const r = row({ text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nkeep going' });
    stampTurnProvenance(r);
    const first = { ...r };
    stampTurnProvenance(r);
    expect(r.turn_origin).toBe(first.turn_origin);
    expect(r.turn_origin_verdict).toBe(first.turn_origin_verdict);
    expect(r.turn_origin_classifier_version).toBe(first.turn_origin_classifier_version);
  });
});
