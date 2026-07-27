/**
 * owner-message.test.ts — the GUI/non-agent sender wrapper (P-033).
 *
 * The regression these pin: `/api/admin/coord/send` dispatches into the
 * `coord:send` tool, where D-048 made `expects` REQUIRED with no default. Every
 * GUI call site posts without it, so all three have been failing validation
 * since D-048 landed — reported by the owner as "the chat in the HUD tab is now
 * broken".
 */

import { describe, it, expect } from 'vitest';
import {
  applyOwnerMessageDefaults,
  deriveOwnerExpects,
  ownerMessageDefaults,
  OWNER_FIELD_PROVENANCE,
} from './owner-message';

describe('the break this fixes', () => {
  it('supplies the `expects` the tool requires — for the exact HUD chat payload', () => {
    // Verbatim shape of SessionChatModal.sendToSessionOwner's POST body.
    const out = applyOwnerMessageDefaults({
      to: ['su-abc'],
      summary: 'hello there',
      body: 'hello there',
      wake: 'required',
    });
    expect(out.expects).toBe('action');
  });

  it('supplies it for the Agents-pill composer and the bare nudge', () => {
    expect(applyOwnerMessageDefaults({ to: ['a'], summary: 'x', body: 'x' }).expects).toBe('action');
    // The nudge posts NO body — the point is to make the agent take a turn.
    expect(
      applyOwnerMessageDefaults({ to: ['a'], summary: '(nudge from the operator)', wake: 'required' }).expects,
    ).toBe('none');
  });
});

describe('deriveOwnerExpects — derived from what the owner actually did', () => {
  it("a bare wake with no body is a nudge → 'none'", () => {
    expect(deriveOwnerExpects({ wake: 'required' })).toBe('none');
    expect(deriveOwnerExpects({ wake: true, body: '   ' })).toBe('none');
  });

  it("anything the owner typed a body for → 'action'", () => {
    expect(deriveOwnerExpects({ body: 'do the thing' })).toBe('action');
    // A body WITH a wake is still a real instruction, not a nudge.
    expect(deriveOwnerExpects({ body: 'do the thing', wake: 'required' })).toBe('action');
  });

  it("does not read an owner instruction as FYI — it stays chased as unanswered", () => {
    // 'none' would drop it out of unanswered_directed, which is the failure to avoid.
    expect(deriveOwnerExpects({ body: 'stop what you are doing' })).not.toBe('none');
  });
});

describe('provenance stamping — the half that keeps measurement honest', () => {
  it('marks every field it derived', () => {
    const d = ownerMessageDefaults({ body: 'hi' });
    expect(d.fieldProvenance).toEqual({
      expects: OWNER_FIELD_PROVENANCE,
      blocking: OWNER_FIELD_PROVENANCE,
      forYouBecause: OWNER_FIELD_PROVENANCE,
    });
  });

  it('does NOT stamp a field the caller supplied — caller values always win', () => {
    const d = ownerMessageDefaults({ body: 'hi', expects: 'answer', blocking: true });
    expect(d.expects).toBe('answer');
    expect(d.blocking).toBe(true);
    expect(d.fieldProvenance.expects).toBeUndefined();
    expect(d.fieldProvenance.blocking).toBeUndefined();
    // Only the one it actually derived.
    expect(d.fieldProvenance.forYouBecause).toBe(OWNER_FIELD_PROVENANCE);
  });

  it('a derived value is never indistinguishable from authored intent', () => {
    const derived = applyOwnerMessageDefaults({ to: ['a'], summary: 's', body: 'b' });
    const authored = applyOwnerMessageDefaults({ to: ['a'], summary: 's', body: 'b', expects: 'action' });
    // Same VALUE, different provenance — which is the whole point.
    expect(derived.expects).toBe(authored.expects);
    expect((derived.fieldProvenance as Record<string, string>).expects).toBe(OWNER_FIELD_PROVENANCE);
    expect((authored.fieldProvenance as Record<string, string>).expects).toBeUndefined();
  });
});

describe('forYouBecause (D-043) for an owner send', () => {
  it("uses 'other' — an owner's reason is not a computed coupling", () => {
    const d = ownerMessageDefaults({ body: 'hi' });
    expect(d.forYouBecause.relation).toBe('other');
  });

  it("carries the note D-043 REQUIRES with 'other'", () => {
    expect(ownerMessageDefaults({ body: 'hi' }).forYouBecause.note).toBeTruthy();
  });
});

describe('upgrading GUI senders to the new body format', () => {
  it('wraps the typed text as a section carrying forYouBecause', () => {
    const out = applyOwnerMessageDefaults({ to: ['a'], summary: 's', body: 'the text' });
    expect(out.body).toEqual([
      {
        text: 'the text',
        forYouBecause: { relation: 'other', note: 'addressed directly by the owner from the operator UI' },
      },
    ]);
  });

  it('leaves a bare nudge as a bare nudge — no empty section for fill-rate theatre', () => {
    const out = applyOwnerMessageDefaults({ to: ['a'], summary: '(nudge)', wake: 'required' });
    expect(out.body).toBeUndefined();
  });

  it('does not re-wrap a caller that already sent sections', () => {
    const sections = [{ text: 'already structured' }];
    expect(applyOwnerMessageDefaults({ to: ['a'], summary: 's', body: sections }).body).toBe(sections);
  });

  it('preserves every unrelated field it was given', () => {
    const out = applyOwnerMessageDefaults({
      to: ['a'],
      summary: 's',
      body: 'b',
      wake: 'required',
      plan_slug: 'some-plan',
    });
    expect(out.to).toEqual(['a']);
    expect(out.summary).toBe('s');
    expect(out.wake).toBe('required');
    expect(out.plan_slug).toBe('some-plan');
  });
});

describe('what it deliberately does NOT invent', () => {
  it('never fabricates why / premises / youMayNotKnow / couldNotDetermine / basedOn', () => {
    const out = applyOwnerMessageDefaults({ to: ['a'], summary: 's', body: 'b' });
    expect(out.why).toBeUndefined();
    expect(out.basedOn).toBeUndefined();
    const section = (out.body as Array<Record<string, unknown>>)[0];
    // A GUI has no goal ref, no reasoning chain and no read-trace. Plausible
    // values here would be exactly the healthy-looking empty schema D-064 warns of.
    expect(section.premises).toBeUndefined();
    expect(section.youMayNotKnow).toBeUndefined();
    expect(section.couldNotDetermine).toBeUndefined();
  });
});
