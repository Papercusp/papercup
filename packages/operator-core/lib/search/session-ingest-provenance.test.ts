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
import {
  stampTurnProvenance,
  UNENROLLED_ORIGIN_VERDICT,
  FILE_BACKED_SOURCE_KINDS,
  correlatePromptOriginStamps,
  promptOriginHash,
  PROMPT_ORIGIN_MATCH_WINDOW_MS,
} from './session-ingest';
import { MACHINE_SURFACE_CATALOGUE_VERSION } from '../turn-provenance/machine-surface-catalogue';
import { classifyRecordedTurn, OWNER_CANDIDATE_TURN_VERDICTS } from '../turn-provenance/turn-ref';

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

  it('stamps an agent_chat owner turn owner-typed', () => {
    const r = row({ source_kind: 'agent_chat', text: 'launch our windows vm please' });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('owner-typed');
    expect(r.turn_origin).toBeNull();
  });

  it.each([...FILE_BACKED_SOURCE_KINDS])('does not assert owner authorship for an unenrolled %s row', (source_kind) => {
    const r = row({ text: 'launch our windows vm please' });
    r.source_kind = source_kind;
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe(UNENROLLED_ORIGIN_VERDICT);
    expect(r.turn_origin).toBeNull();
  });

  /**
   * THE INGEST DECISION HAS A SEARCH-SIDE CONSEQUENCE, AND THIS IS THE ONLY
   * THING THAT TIES THEM TOGETHER.
   *
   * Downgrading an uncorrelated residual is correct, but it means
   * `turn_origin:'owner-typed'` and `owner_only:true` exclude that residual on
   * file-backed CLI sessions. The hook-authenticated prompt-origin path then
   * promotes an exact source/session/hash/time match back to `owner-typed`, so
   * the search filters are sparse rather than structurally unreachable.
   *
   * These tests fail if the two halves drift apart in EITHER direction — a
   * renamed ingest verdict, a candidate set that stops covering the residual,
   * or a correlation path that no longer makes an exact owner row reachable.
   */
  it('keeps the verdict it downgrades to inside the owner-CANDIDATE set the search filters on', () => {
    // CALIBRATION: the assertion below is a loop over a set, so an empty set
    // would pass it vacuously — which is the one way this guard could rot into
    // proving nothing while staying green.
    expect(FILE_BACKED_SOURCE_KINDS.size).toBeGreaterThan(0);

    for (const source_kind of FILE_BACKED_SOURCE_KINDS) {
      const r = row({ text: 'put yourself on auto mode and continue where you left off' });
      r.source_kind = source_kind;
      stampTurnProvenance(r);

      // The residual is refused (the ingest half, restated as this test's premise) ...
      expect(r.turn_origin_verdict).not.toBe('owner-typed');
      // ... so the verdict it lands on MUST remain findable, or a real owner
      // directive becomes unreachable and its absence reads as proof.
      expect(OWNER_CANDIDATE_TURN_VERDICTS).toContain(r.turn_origin_verdict);
    }
  });

  it('keeps ENVELOPED machine verdicts out of the candidate set — the bound on how far widening may go', () => {
    // The inverse failure turn-origin.ts exists to kill: a loop-fire replay
    // reading back as owner speech. `owner_candidates` is deliberately wider
    // than `owner_only` but must never widen this far.
    const replay = row({ text: '⟦turn-origin:loop-fire nonce:095d0a31d74f617e⟧\nkeep going' });
    stampTurnProvenance(replay);
    expect(replay.turn_origin_verdict).toBe('agent-injected');
    expect(OWNER_CANDIDATE_TURN_VERDICTS).not.toContain(replay.turn_origin_verdict);

    const assistant = row({ speaker: 'assistant', text: 'I will do that next.' });
    stampTurnProvenance(assistant);
    expect(OWNER_CANDIDATE_TURN_VERDICTS).not.toContain(assistant.turn_origin_verdict);
  });

  /**
   * WHAT THE TEST ABOVE DOES NOT BUY — pinned so nobody reads it as more.
   *
   * Excluding `agent-injected` bounds the widening at ENVELOPED machine turns
   * only. Machine text that never carried an envelope lands in
   * `unenrolled-origin` right beside genuine owner speech, so the candidate set
   * is a mixed bucket by construction, not by accident.
   *
   * This was measured against production, and it is the hole the unit fixtures
   * could not show: of 13,917 real `unenrolled-origin` claude rows on
   * 2026-08-24, at least 7,637 (55%) were machine-shaped — Kettle/Mug system
   * prompts, `[await-event] … fired` wake injections, `/compact …` directives,
   * harness retry text. A fixture cannot surface that, because the author who
   * invents the fixture text has the same blind spot as the code.
   *
   * Hence `owner_candidates` is a RECALL aid whose hits must be read, never
   * authorship evidence — and this test fails if that framing is ever quietly
   * upgraded by folding the candidate set into a proof-shaped one.
   */
  it('does not let an un-enveloped machine turn be distinguishable from owner speech by verdict alone', () => {
    const machine = row({ source_kind: 'claude', text: '[await-event] coord:inbox-wake:su-1 fired — 🔁 Loop wake' });
    const owner = row({ source_kind: 'claude', text: 'put yourself on auto mode and continue where you left off' });
    stampTurnProvenance(machine);
    stampTurnProvenance(owner);

    // Both land in the candidate bucket: the verdict CANNOT separate them.
    expect(OWNER_CANDIDATE_TURN_VERDICTS).toContain(machine.turn_origin_verdict);
    expect(OWNER_CANDIDATE_TURN_VERDICTS).toContain(owner.turn_origin_verdict);
    expect(machine.turn_origin_verdict).toBe(owner.turn_origin_verdict);

    // So the candidate set must stay strictly WIDER than the proven-owner set —
    // if it ever equals it, someone has turned candidates into a proof claim.
    expect(OWNER_CANDIDATE_TURN_VERDICTS).toContain(UNENROLLED_ORIGIN_VERDICT);
    expect(OWNER_CANDIDATE_TURN_VERDICTS.length).toBeGreaterThan(2);
  });

  it('keeps the bare native-CLI machine/owner ambiguity explicit instead of using the residual', () => {
    const machine = row({ source_kind: 'claude', text: 'Continue from where you left off.' });
    const owner = row({ source_kind: 'claude', text: 'continue from where you left off.' });
    stampTurnProvenance(machine);
    stampTurnProvenance(owner);
    expect(machine.turn_origin_verdict).toBe(UNENROLLED_ORIGIN_VERDICT);
    expect(owner.turn_origin_verdict).toBe(UNENROLLED_ORIGIN_VERDICT);
  });

  it('still classifies a known un-enrollable machine marker for display consumers', () => {
    const r = row({ source_kind: 'claude', text: '[Request interrupted by user]' });
    stampTurnProvenance(r);
    expect(r.turn_origin_verdict).toBe('machine-surface');
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

describe('hook-authenticated prompt-origin correlation', () => {
  it('keeps the hook and ingest hash normalization in lockstep', () => {
    expect(promptOriginHash('  line one\r\nline two\r\n ')).toBe(
      promptOriginHash('line one\nline two'),
    );
  });

  it('upgrades only an exact v5 unenrolled user row and consumes each stamp once', () => {
    const submittedAt = '2026-09-01T10:00:00.000Z';
    const hash = promptOriginHash('owner directive');
    const candidate = row({
      ts: submittedAt,
      prompt_hash: hash,
      text: 'owner directive',
    });
    stampTurnProvenance(candidate);
    expect(candidate.turn_origin_verdict).toBe(UNENROLLED_ORIGIN_VERDICT);
    const machine = row({
      turn_idx: 1,
      ts: submittedAt,
      prompt_hash: hash,
      turn_origin_verdict: 'machine-surface',
      turn_origin_classifier_version: MACHINE_SURFACE_CATALOGUE_VERSION,
    });
    const stamp = {
      source_kind: 'claude',
      session_id: 's-1',
      prompt_hash: hash,
      submitted_at: submittedAt,
    };

    expect(correlatePromptOriginStamps([candidate, machine], [stamp])).toBe(1);
    expect(candidate.turn_origin_verdict).toBe('owner-typed');
    expect(machine.turn_origin_verdict).toBe('machine-surface');
    expect(correlatePromptOriginStamps([candidate], [stamp])).toBe(0);
  });

  it.each([
    ['wrong source', { source_kind: 'omp' }],
    ['wrong session', { session_id: 'other-session' }],
    ['wrong hash', { prompt_hash: promptOriginHash('different directive') }],
    ['outside time window', { submitted_at: new Date(Date.parse('2026-09-01T10:00:00.000Z') - PROMPT_ORIGIN_MATCH_WINDOW_MS - 1).toISOString() }],
  ])('does not correlate %s', (_label, override) => {
    const submittedAt = '2026-09-01T10:00:00.000Z';
    const hash = promptOriginHash('owner directive');
    const candidate = row({
      ts: submittedAt,
      prompt_hash: hash,
      turn_origin_verdict: UNENROLLED_ORIGIN_VERDICT,
      turn_origin_classifier_version: MACHINE_SURFACE_CATALOGUE_VERSION,
    });
    const stamp = {
      source_kind: 'claude',
      session_id: 's-1',
      prompt_hash: hash,
      submitted_at: submittedAt,
      ...override,
    };
    expect(correlatePromptOriginStamps([candidate], [stamp])).toBe(0);
    expect(candidate.turn_origin_verdict).toBe(UNENROLLED_ORIGIN_VERDICT);
  });
});
