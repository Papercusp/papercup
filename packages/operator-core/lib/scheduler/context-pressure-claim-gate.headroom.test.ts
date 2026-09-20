/**
 * EI-23744538757758407 — the context-pressure gate must not prescribe a remedy that PROVABLY
 * cannot clear the breach it is refusing on.
 *
 * The filed reproduction: a brand-new Opus-5-1M fleet member is seeded at the 250k member cap but
 * boots at ~362k of FIXED per-turn baseline (kernel + playbook + client overlay + spliced project
 * guide + wire schemas). Its FIRST `scheduler:get_next` — after three read-only calls — refused
 * with recoveryPath 'self-compaction'. Compaction removes ACCUMULATED context; it cannot remove
 * the baseline, so a fresh context boots at the same 362k and is refused again, forever.
 *
 * The defect is the SELECTION, not the refusal: the remedy was chosen purely by which recovery
 * PATH was available, never by whether that path could clear the breach. These tests pin the
 * corrected rule, including the part that is easy to get backwards — the precedence over
 * 'cold-loop', which buys a fresh context and is therefore just as incapable as compaction here.
 */
import { describe, it, expect } from 'vitest';
import { decideContextPressureGate, raisingLimitWouldClear } from './context-pressure-claim-gate';

/** The measured reproduction from the filing. 362523/825000 ≈ 44% — below any band. */
const FILED = { contextTokens: 362523, softLimit: 250000, selfSetCeiling: 825000 };

function refusal(input: Parameters<typeof decideContextPressureGate>[0]) {
  const d = decideContextPressureGate(input);
  if (!d.refuse) throw new Error('expected a refusal for this fixture');
  return d;
}

describe('raisingLimitWouldClear', () => {
  it('is TRUE for the filed reproduction, and suggests the ceiling', () => {
    expect(raisingLimitWouldClear(FILED)).toEqual({ clears: true, suggestedLimit: 825000 });
  });

  it('is FALSE when the session is already AT its ceiling (nothing to raise into)', () => {
    expect(raisingLimitWouldClear({ ...FILED, softLimit: 825000 }).clears).toBe(false);
  });

  it('is FALSE when raising to the ceiling would STILL be critical', () => {
    // 820000/825000 ≈ 99.4%: critical under any plausible threshold, so raising is not a fix and
    // must not be offered as one — this session genuinely does have to shed context.
    expect(raisingLimitWouldClear({ ...FILED, contextTokens: 820000 }).clears).toBe(false);
  });

  it('is FALSE on absent or non-finite facts — unknown is never an assertion', () => {
    expect(raisingLimitWouldClear(null).clears).toBe(false);
    expect(raisingLimitWouldClear(undefined).clears).toBe(false);
    expect(raisingLimitWouldClear({ ...FILED, selfSetCeiling: null }).clears).toBe(false);
    expect(raisingLimitWouldClear({ ...FILED, contextTokens: undefined }).clears).toBe(false);
    expect(raisingLimitWouldClear({ ...FILED, softLimit: Number.NaN }).clears).toBe(false);
    expect(raisingLimitWouldClear({ ...FILED, selfSetCeiling: Number.POSITIVE_INFINITY }).clears).toBe(false);
  });
});

describe('the gate prescribes raising the limit when that provably clears the breach', () => {
  it('names config:set-compaction-limit with the concrete ceiling, and does NOT say compact', () => {
    const d = refusal({ bucket: 'critical', headroom: FILED });
    expect(d.error).toMatch(/config:set-compaction-limit \{ limit: 825000 \}/);
    expect(d.diagnosis.suggestedLimit).toBe(825000);
    expect(d.diagnosis.remedy).toMatch(/raise/i);
    // The whole point of the filing: it must stop prescribing session:request-compaction here.
    expect(d.error).not.toMatch(/session:request-compaction/);
  });

  it('says WHY compaction cannot work, rather than silently omitting it', () => {
    const d = refusal({ bucket: 'critical', headroom: FILED });
    expect(d.error).toMatch(/baseline/i);
  });

  it('still refuses — this changes the REMEDY, never the verdict or the lane disclaimer', () => {
    const d = refusal({ bucket: 'critical', headroom: FILED });
    expect(d.diagnosis.contextPressureBlocked).toBe(true);
    expect(d.diagnosis.laneEvaluated).toBe(false);
  });

  it('TAKES PRECEDENCE over cold-loop, which also only buys a fresh context', () => {
    const d = refusal({
      bucket: 'critical',
      headroom: FILED,
      recovery: { path: 'cold-loop', carryNoteVerified: true },
    });
    expect(d.diagnosis.suggestedLimit).toBe(825000);
    expect(d.diagnosis.remedy).toMatch(/raise/i);
    // Assert against the remedy's real CONTENT. An earlier draft asserted /cold-loop settle/,
    // which is the LABEL and never appears in the error text — so it could not have failed even
    // if precedence were broken. `loop:checkpoint` is the cold-loop text's distinctive phrase.
    expect(d.error).not.toMatch(/loop:checkpoint/);
    expect(d.error).not.toMatch(/COLD loop/);
    expect(d.diagnosis.remedy).not.toMatch(/cold-loop/);
    // The path is still REPORTED — we suppress the wrong advice, not the diagnostic fact.
    expect(d.diagnosis.recoveryPath).toBe('cold-loop');
  });

  it('takes precedence over warm-loop too', () => {
    const d = refusal({ bucket: 'critical', headroom: FILED, recovery: { path: 'warm-loop' } });
    expect(d.diagnosis.suggestedLimit).toBe(825000);
    expect(d.error).not.toMatch(/session:request-compaction/);
  });
});

describe('legacy behaviour is preserved wherever raising is not provably the fix', () => {
  it('omitted headroom keeps the compaction wording verbatim', () => {
    const d = refusal({ bucket: 'critical' });
    expect(d.diagnosis.suggestedLimit).toBeNull();
    expect(d.error).toMatch(/compact/i);
    expect(d.diagnosis.remedy).not.toMatch(/raise/i);
  });

  it('a session at its ceiling is told to shed context, not to raise a limit it cannot raise', () => {
    const d = refusal({ bucket: 'critical', headroom: { ...FILED, softLimit: 825000 } });
    expect(d.diagnosis.suggestedLimit).toBeNull();
    expect(d.error).toMatch(/compact/i);
  });

  it('preserves the cold-loop remedy when there is no headroom to raise into', () => {
    const d = refusal({
      bucket: 'critical',
      headroom: { ...FILED, softLimit: 825000 },
      recovery: { path: 'cold-loop', carryNoteVerified: true },
    });
    // The error embeds the remedy TEXT ("the armed COLD loop is the fresh-context boundary"),
    // while 'cold-loop' with the hyphen is the LABEL — assert each where it actually lives.
    expect(d.error).toMatch(/COLD loop/);
    expect(d.diagnosis.remedy).toMatch(/cold-loop/);
    expect(d.diagnosis.suggestedLimit).toBeNull();
  });

  it('does not disturb the fail-open axis — headroom never manufactures a refusal', () => {
    // The central hazard the module was built around: a false 'critical' is the worse failure.
    for (const bucket of ['ok', 'high'] as const) {
      expect(decideContextPressureGate({ bucket, headroom: FILED }).refuse).toBe(false);
    }
    expect(decideContextPressureGate({ bucket: null, headroom: FILED }).refuse).toBe(false);
    expect(decideContextPressureGate({ bucket: 'critical', override: true, headroom: FILED }).refuse).toBe(false);
    expect(decideContextPressureGate({ bucket: 'critical', enabled: false, headroom: FILED }).refuse).toBe(false);
  });
});
