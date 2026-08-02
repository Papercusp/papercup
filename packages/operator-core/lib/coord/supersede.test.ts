import { describe, expect, it } from 'vitest';

import { isOriginalSender, planSupersession, resolveSupersessionAudience } from './supersede';

/** plan agent-epistemics-2026-08-02 P-004. */
const SENDER = 'su-707029ce-300a-469b-8fca-4cd393f5a0d2';
const envelope = (over: Record<string, unknown> = {}) => ({
  msg_id: 'msc5xf5i-0000-abc',
  from: SENDER,
  to: ['@fleet:nonp2p-bug-drain-0801', 'su-37bf2c28-d001-44bf-8e3e-59ac25cb002b'],
  summary: 'gate is judging candidate 4961cfb8',
  kind: 'message',
  ...over,
});

describe('resolveSupersessionAudience — reach the ORIGINAL audience, not a hand-retyped one', () => {
  it('returns the envelope selectors VERBATIM so a correction costs one call, not N', () => {
    expect(resolveSupersessionAudience(envelope())).toEqual([
      '@fleet:nonp2p-bug-drain-0801',
      'su-37bf2c28-d001-44bf-8e3e-59ac25cb002b',
    ]);
  });

  it('tolerates a malformed or absent recipient list rather than throwing', () => {
    for (const to of [undefined, null, 'not-an-array', [], [null, 42, '', '   ']]) {
      expect(resolveSupersessionAudience(envelope({ to }))).toEqual([]);
    }
  });

  it('trims but does not rewrite selectors — re-resolution is the point', () => {
    expect(resolveSupersessionAudience(envelope({ to: ['  @topic:federation  '] }))).toEqual(['@topic:federation']);
  });
});

describe('planSupersession — the integrity rule', () => {
  it('REFUSES a third party: a retraction inherits the original audience AND authority', () => {
    const r = planSupersession({ envelope: envelope(), ownerId: 'su-someone-else', correction: 'actually it was 8592e24a' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('not-sender');
    // The refusal must name the alternative that DOES work, not just say no.
    expect(r.detail).toContain('reply');
  });

  it('distinguishes not-found from not-sender — they have different next actions', () => {
    const missing = planSupersession({ envelope: null, ownerId: SENDER, correction: 'x' });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error('unreachable');
    expect(missing.reason).toBe('not-found');
  });

  it('REFUSES superseding an already-superseded message, keeping the chain linear', () => {
    const r = planSupersession({
      envelope: envelope(),
      ownerId: SENDER,
      correction: 'x',
      supersededByMsgId: 'msc-later-correction',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('already-superseded');
    expect(r.detail).toContain('msc-later-correction');
  });

  it('REFUSES a self-reference', () => {
    const r = planSupersession({
      envelope: envelope(),
      ownerId: SENDER,
      correction: 'x',
      newMsgId: 'msc5xf5i-0000-abc',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('self-reference');
  });

  it('REFUSES when the stored envelope records no recipients', () => {
    const r = planSupersession({ envelope: envelope({ to: [] }), ownerId: SENDER, correction: 'x' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('no-audience');
  });
});

describe('planSupersession — the correction itself', () => {
  it('leads with what it RETRACTS so a skimmer cannot read it as a fresh independent claim', () => {
    const r = planSupersession({
      envelope: envelope(),
      ownerId: SENDER,
      correction: 'The judged candidate was 8592e24a; my earlier reading came from a stale manual log.',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.body.startsWith('⚠ SUPERSEDES msc5xf5i-0000-abc')).toBe(true);
    expect(r.body).toContain('gate is judging candidate 4961cfb8');
    expect(r.body).toContain('8592e24a');
    // It must tell the reader the LATER-reader problem is handled too.
    expect(r.body).toContain('catching up later');
    expect(r.audience).toHaveLength(2);
  });

  it('derives a summary naming the superseded id, and honours an explicit one', () => {
    const auto = planSupersession({ envelope: envelope(), ownerId: SENDER, correction: 'c' });
    if (!auto.ok) throw new Error('unreachable');
    expect(auto.summary).toContain('CORRECTION superseding msc5xf5i-0000-abc');

    const explicit = planSupersession({
      envelope: envelope(),
      ownerId: SENDER,
      correction: 'c',
      correctionSummary: 'candidate was 8592e24a, not 4961cfb8',
    });
    if (!explicit.ok) throw new Error('unreachable');
    expect(explicit.summary).toBe('candidate was 8592e24a, not 4961cfb8');
  });
});

describe('isOriginalSender', () => {
  it('matches on trimmed identity and rejects every empty/absent shape', () => {
    expect(isOriginalSender(envelope(), ` ${SENDER} `)).toBe(true);
    expect(isOriginalSender(envelope({ from: `  ${SENDER}  ` }), SENDER)).toBe(true);
    for (const from of [undefined, null, '', '   ', 42]) {
      expect(isOriginalSender(envelope({ from }), SENDER)).toBe(false);
    }
  });
});
