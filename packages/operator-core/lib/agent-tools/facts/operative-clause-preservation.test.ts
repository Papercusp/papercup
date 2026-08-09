/**
 * P-002 (knowledge-at-symptom-time-2026-08-09) — facts:list must truncate EVIDENCE, never INSTRUCTION.
 *
 * The incident: two standing facts that would have prevented a wrong owner-facing diagnosis were
 * folded into an agent's SECOND tool call of the session, and both were cut mid-instruction. One
 * rendered literally as `... is NOT self-validating. ALWAYS cross-read acco…` — the excerpt severed
 * the verb inside the word "accounts:status". The head kept the fact's evidence (re-derivable) and
 * discarded its instruction (the only part that changes behaviour). The agent then spent ~12 tool
 * calls re-deriving what the fact already said, and relayed a wrong recommendation to the owner.
 */
import { describe, it, expect } from 'vitest';
import {
  projectFact,
  extractOperativeClauses,
  FACTS_LIST_EXCERPT_CHARS,
  FACTS_LIST_OPERATIVE_CHARS,
  FACTS_LIST_OPERATIVE_MAX_CLAUSES,
} from './list';

/** The real body from the 2026-08-09 incident (workspace fact `capacity-poolexhausted-can-mean-saturation`). */
const INCIDENT_BODY =
  '⟦CONCLUSION⟧ fleet:capacity poolExhausted:true + advice "DOMINANT CAUSE: 3/3 edge-throttled → egress broken → ESCALATE (owner-gated)" is NOT self-validating. ' +
  'ALWAYS cross-read accounts:status before escalating: a transport/edge throttle is not an account usage wall, and only the usage wall means the pool is really out of capacity.';

const asFact = (body: string) =>
  ({ scope: 'workspace', scopeRef: null, key: 'k', body, sourceRef: null, createdBy: 'x', updatedAt: '', expiresAt: '' }) as never;

const bodyOf = (body: string) => projectFact(asFact(body), false).body as string;

describe('facts:list operative-clause preservation', () => {
  it('preserves the instruction from the REAL incident body that was severed mid-word', () => {
    const out = bodyOf(INCIDENT_BODY);
    expect(out).toContain('⚠ OPERATIVE:');
    // The whole actionable verb phrase survives — not "ALWAYS cross-read acco".
    expect(out).toContain('ALWAYS cross-read accounts:status');
    expect(projectFact(asFact(INCIDENT_BODY), false).body_operative_preserved).toBe(true);
  });

  it('still reports the truncation honestly', () => {
    const p = projectFact(asFact(INCIDENT_BODY), false);
    expect(p.body_truncated).toBe(true);
    expect(p.body_full_chars).toBe(INCIDENT_BODY.length);
  });

  it('preserves an imperative that falls ENTIRELY past the cut', () => {
    const body = `${'evidence '.repeat(40)}NEVER reap a member off a harness-filtered census.`;
    expect(bodyOf(body)).toContain('NEVER reap a member off a harness-filtered census.');
  });

  // ── The control that stops this inflating every response (EI-10948 shrank it for a real reason) ──
  it('does NOT add anything to a fact with no imperative — plain prose keeps the old head-only shape', () => {
    const body = 'x'.repeat(400);
    const p = projectFact(asFact(body), false);
    expect(p.body).toBe(`${'x'.repeat(FACTS_LIST_EXCERPT_CHARS)}…`);
    expect(p.body).not.toContain('OPERATIVE');
    expect(p.body_operative_preserved).toBeUndefined();
  });

  it('leaves a short (uncut) body completely untouched', () => {
    const body = 'ALWAYS do the thing.';
    const p = projectFact(asFact(body), false);
    expect(p.body).toBe(body);
    expect(p.body_truncated).toBeUndefined();
  });

  it('does not spend budget repeating an imperative already visible in the head', () => {
    const body = `ALWAYS check the writer. ${'tail evidence '.repeat(40)}`;
    expect(bodyOf(body)).not.toContain('⚠ OPERATIVE:');
  });

  it('is BOUNDED — a body stuffed with imperatives cannot blow the response budget', () => {
    const body = `${'lead '.repeat(50)}${'ALWAYS do a fairly long and wordy thing that runs on. '.repeat(20)}`;
    const clauses = extractOperativeClauses(body, body.slice(0, FACTS_LIST_EXCERPT_CHARS));
    expect(clauses.length).toBeLessThanOrEqual(FACTS_LIST_OPERATIVE_MAX_CLAUSES);
    expect(clauses.join(' ').length).toBeLessThanOrEqual(FACTS_LIST_OPERATIVE_CHARS + 4);
  });

  it('matches the shouted forms only — ordinary lowercase prose is not an instruction', () => {
    const body = `${'x'.repeat(200)} we must have missed it, and we should always check.`;
    expect(extractOperativeClauses(body, body.slice(0, FACTS_LIST_EXCERPT_CHARS))).toHaveLength(0);
  });
});

/**
 * FALSIFIABILITY CONTROL — kept permanently. `headOnly` is the implementation that shipped and caused
 * the incident. Asserting it FAILS on the incident body proves these tests discriminate: if
 * `projectFact` ever regresses to a blind slice, the assertions above stop being satisfiable.
 */
const headOnly = (body: string) =>
  body.length > FACTS_LIST_EXCERPT_CHARS ? `${body.slice(0, FACTS_LIST_EXCERPT_CHARS)}…` : body;

describe('falsifiability control', () => {
  it('the shipped head-only slice DID lose the instruction on this exact body', () => {
    const old = headOnly(INCIDENT_BODY);
    // Reproduces the real failure: the verb is severed inside "accounts:status".
    expect(old).toContain('ALWAYS cross-read acco');
    expect(old).not.toContain('ALWAYS cross-read accounts:status');
    // ...and the fix genuinely differs from it.
    expect(bodyOf(INCIDENT_BODY)).not.toBe(old);
  });

  it('the two AGREE on a body with no imperative — the control is not merely inverting everything', () => {
    const body = 'y'.repeat(400);
    expect(bodyOf(body)).toBe(headOnly(body));
  });
});
